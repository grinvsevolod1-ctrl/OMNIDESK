import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import * as repo from './repo.js'
import {
  connect,
  disconnect,
  execStream,
  type ExecResult,
  type SshConnection,
} from './ssh.js'
import {
  AGENT_LIMITS,
  clampOutput,
  screenCommand,
} from './agent-safety.js'
import {
  AGENT_MODEL,
  chatWithTools,
  isGatewayConfigured,
  type ChatMessage,
  type ToolCall,
} from './gateway.js'
import { systemPrompt, toolDefs, userContext } from './agent-prompts.js'

/**
 * The autonomous deploy agent. Given a server and a repo, it SSHes in, analyses
 * the box, installs whatever is missing, clones/builds/runs the project, wires up
 * a reverse proxy + HTTPS, and fixes errors as it goes — narrating every step
 * into the live deploy log. It's an agentic tool loop over the AI Gateway: the
 * model decides the next shell command, the worker runs it (after a safety
 * screen) and streams the output back, until the model calls `finish`.
 *
 * Security & safety:
 *  - every command is screened against a denylist (see agent-safety.ts);
 *  - the SSH host key is pinned (see ssh.ts);
 *  - the private-repo token is injected server-side by `clone_repo` and never
 *    enters the model context; it's also redacted from any streamed log line;
 *  - the run is bounded by step, per-command and total-time limits, and the
 *    admin can cancel it (the loop polls the deployment status between steps).
 */

const APPS_ROOT = '/opt/omnidesk-apps'

/** Log/stream channels for a deployment (mirrors DeployLogStream in the panel). */
type DeployStream = 'stdout' | 'stderr' | 'system' | 'agent' | 'command'

/** Mutable per-run state threaded through the tool loop. */
interface AgentState {
  /** Current working directory; `cd` inside run_command persists here. */
  cwd: string
}

/** Marker used to read back the shell's cwd after each command runs. */
const CWD_MARKER = '__OMNIDESK_CWD__'

/** POSIX single-quote escaping so a value can't break out of the shell. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * If a streamed line carries the cwd marker, return the captured path (may be
 * an empty string if pwd was empty); otherwise return null so the caller knows
 * to treat it as normal output.
 */
function readCwdMarker(line: string): string | null {
  const idx = line.indexOf(CWD_MARKER)
  if (idx === -1) return null
  return line.slice(idx + CWD_MARKER.length).trim()
}

/** Remove any cwd-marker line from a captured stdout blob. */
function stripCwdMarker(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.includes(CWD_MARKER))
    .join('\n')
}

/** Terminal deployment states — the agent stops if it sees one (e.g. cancel). */
function isTerminal(status: string | null): boolean {
  return status === 'success' || status === 'failed' || status === null
}

interface AgentOutcome {
  success: boolean
  summary: string
  url: string | null
  serverNotes: string | null
  /** Agent memory about THIS app (build/run specifics) for future redeploys. */
  appNotes?: string | null
}

/** Entry point: run an autonomous deploy for a job. */
export async function runAiDeploy(job: repo.DeployJob): Promise<void> {
  const { app_id: appId, deployment_id: deploymentId } = job
  if (!appId || !deploymentId) {
    throw new Error('ai_deploy job missing app_id/deployment_id')
  }

  const log = (
    stream: 'stdout' | 'stderr' | 'system' | 'agent' | 'command',
    line: string,
  ): Promise<void> => repo.appendDeployLog(deploymentId, stream, line)

  if (!isGatewayConfigured()) {
    await log('stderr', 'AI_GATEWAY_API_KEY не задан — автономный агент недоступен.')
    await repo.setDeploymentStatus(deploymentId, 'failed', {
      finished: true,
      summary: 'Не настроен AI_GATEWAY_API_KEY.',
    })
    await repo.setAppStatus(appId, 'error', 'AI_GATEWAY_API_KEY не задан')
    throw new Error('AI_GATEWAY_API_KEY not set')
  }

  const app = await repo.getApp(appId)
  if (!app) throw new Error('app not found')
  const server = await repo.getServer(app.server_id)
  if (!server) throw new Error('server not found')
  if (!server.secret) throw new Error('server has no SSH credentials')

  await repo.setDeploymentStatus(deploymentId, 'cloning', { started: true })
  await repo.setAppStatus(appId, 'building', null)
  await log('system', `Агент (${AGENT_MODEL}) подключается к ${server.ip_address}:${server.ssh_port}…`)

  // Redact the repo token from any log line so it never leaks.
  const token = app.repoToken
  const redact = (s: string): string =>
    token ? s.split(token).join('***') : s

  let conn: SshConnection | null = null
  const startedAt = Date.now()
  try {
    conn = await connect({
      host: server.ip_address,
      port: server.ssh_port,
      username: server.ssh_username,
      authType: server.auth_type,
      secret: server.secret,
      pinnedFingerprint: server.host_fingerprint,
    })
    if (!server.host_fingerprint) {
      await repo.pinServerFingerprint(server.id, conn.fingerprint)
      await log('system', `Host key закреплён (${conn.fingerprint.slice(0, 24)}…)`)
    }
    const client = conn.client
    const appDir = `${APPS_ROOT}/${app.id}`

    /**
     * Run a command, streaming output (via onLine) with two guardrails:
     *  - a per-command time limit, and
     *  - cooperative cancellation: we poll the deployment status while the
     *    command runs and abort the SSH channel the moment the admin cancels,
     *    so even a long `npm install` stops promptly instead of finishing.
     */
    const runStreaming = (
      command: string,
      onLine?: (s: DeployStream, line: string) => void,
    ): Promise<ExecResult> => {
      const controller = new AbortController()
      let cancelled = false
      const poll = setInterval(() => {
        void repo.getDeploymentStatus(deploymentId).then((st) => {
          if (isTerminal(st)) {
            cancelled = true
            controller.abort()
          }
        })
      }, AGENT_LIMITS.cancelPollMs)
      poll.unref?.()
      const timer = setTimeout(() => controller.abort(), AGENT_LIMITS.perCommandMs)
      const sink = onLine ?? ((s: DeployStream, line: string) => void log(s, redact(line)))
      return execStream(client, command, sink, controller.signal).finally(() => {
        clearInterval(poll)
        clearTimeout(timer)
      }).catch((err: unknown) => {
        if (cancelled) throw new Error('установка отменена')
        if (controller.signal.aborted) {
          throw new Error(`команда превысила лимит ${AGENT_LIMITS.perCommandMs / 1000}с`)
        }
        throw err instanceof Error ? err : new Error(String(err))
      })
    }

    const outcome = await runAgentLoop({
      app,
      server,
      appDir,
      deploymentId,
      token,
      log,
      redact,
      runStreaming,
      client,
      startedAt,
      state: { cwd: appDir },
    })

    if (outcome.success) {
      await repo.setDeploymentStatus(deploymentId, 'success', {
        finished: true,
        summary: outcome.summary,
        siteUrl: outcome.url,
      })
      await repo.setAppStatus(appId, 'running', null)
      if (outcome.serverNotes) {
        await repo.setServerAgentNotes(server.id, outcome.serverNotes)
      }
      if (outcome.appNotes) {
        await repo.setAppAgentNotes(appId, outcome.appNotes)
      }
      await log('system', `Готово: ${outcome.summary}`)
    } else {
      await repo.setDeploymentStatus(deploymentId, 'failed', {
        finished: true,
        summary: outcome.summary,
      })
      await repo.setAppStatus(appId, 'error', outcome.summary)
      await log('stderr', `Не удалось: ${outcome.summary}`)
    }
  } catch (err) {
    const msg = redact(err instanceof Error ? err.message : String(err))
    logger.error({ err: msg, appId }, 'ai deploy failed')
    await log('stderr', `Ошибка агента: ${msg}`)
    await repo.setDeploymentStatus(deploymentId, 'failed', {
      finished: true,
      summary: msg,
    })
    await repo.setAppStatus(appId, 'error', msg)
    throw err
  } finally {
    if (conn) disconnect(conn.client)
  }
}

/** The agentic tool loop. Returns the terminal outcome. */
async function runAgentLoop(ctx: {
  app: repo.AppRecord
  server: repo.ServerRecord
  appDir: string
  deploymentId: string
  token: string | null
  log: (stream: DeployStream, line: string) => Promise<void>
  redact: (s: string) => string
  runStreaming: (
    command: string,
    onLine?: (s: DeployStream, line: string) => void,
  ) => Promise<ExecResult>
  client: SshConnection['client']
  startedAt: number
  state: AgentState
}): Promise<AgentOutcome> {
  const { app, server, appDir, deploymentId, token, log, redact, runStreaming } = ctx

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userContext(app, server, appDir) },
  ]

  let tokensUsed = 0
  // Record whatever we consumed, even on failure/cancel paths (best-effort).
  const recordTokens = (): void => {
    if (tokensUsed > 0) {
      void repo.setDeploymentTokens(deploymentId, tokensUsed).catch(() => {})
    }
  }

  for (let step = 0; step < AGENT_LIMITS.maxSteps; step++) {
    // Time budget.
    if (Date.now() - ctx.startedAt > AGENT_LIMITS.totalMs) {
      recordTokens()
      return {
        success: false,
        summary: 'Превышено общее время установки.',
        url: null,
        serverNotes: null,
      }
    }
    // Token budget: hard stop against runaway model loops burning money.
    if (tokensUsed > AGENT_LIMITS.maxTokens) {
      recordTokens()
      return {
        success: false,
        summary: `Превышен бюджет токенов на установку (${AGENT_LIMITS.maxTokens}).`,
        url: null,
        serverNotes: null,
      }
    }
    // Cooperative cancellation: admin may have cancelled the deployment.
    const status = await repo.getDeploymentStatus(deploymentId)
    if (isTerminal(status)) {
      recordTokens()
      return {
        success: false,
        summary: 'Установка остановлена.',
        url: null,
        serverNotes: null,
      }
    }

    let turn
    try {
      turn = await chatWithTools(messages, toolDefs())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await log('stderr', `Модель недоступна: ${msg}`)
      recordTokens()
      return { success: false, summary: `Модель недоступна: ${msg}`, url: null, serverNotes: null }
    }
    tokensUsed += turn.tokensUsed

    if (turn.content) await log('agent', turn.content)

    // No tool calls → the model is done talking without finishing. Nudge once,
    // then give up to avoid an infinite loop.
    if (turn.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: turn.content })
      messages.push({
        role: 'user',
        content:
          'Продолжи установку конкретными командами или вызови finish, если всё готово или дальше нельзя.',
      })
      continue
    }

    messages.push({
      role: 'assistant',
      content: turn.content,
      tool_calls: turn.toolCalls,
    })

    for (const call of turn.toolCalls) {
      const result = await executeTool(call, {
        app,
        appDir,
        deploymentId,
        token,
        log,
        redact,
        runStreaming,
        client: ctx.client,
        state: ctx.state,
      })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result.payload),
      })
      if (result.finish) {
        recordTokens()
        return result.finish
      }
    }
  }

  recordTokens()
  return {
    success: false,
    summary: 'Агент не завершил установку за отведённое число шагов.',
    url: null,
    serverNotes: null,
  }
}

/** Execute one tool call. Returns a payload for the model, or a terminal outcome. */
async function executeTool(
  call: ToolCall,
  ctx: {
    app: repo.AppRecord
    appDir: string
    deploymentId: string
    token: string | null
    log: (stream: DeployStream, line: string) => Promise<void>
    redact: (s: string) => string
    runStreaming: (
      command: string,
      onLine?: (s: DeployStream, line: string) => void,
    ) => Promise<ExecResult>
    client: SshConnection['client']
    state: AgentState
  },
): Promise<{ payload: unknown; finish?: AgentOutcome }> {
  const { app, appDir, token, log, redact, runStreaming, state } = ctx
  let args: Record<string, unknown> = {}
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
  } catch {
    return { payload: { ok: false, error: 'не удалось разобрать аргументы' } }
  }

  switch (call.function.name) {
    case 'run_command': {
      const command = String(args.command ?? '').trim()
      const explanation = String(args.explanation ?? '').trim()
      if (!command) return { payload: { ok: false, error: 'пустая команда' } }
      const screen = screenCommand(command)
      if (screen.blocked) {
        await log('agent', `Отклонил опасную команду: ${screen.reason}`)
        return {
          payload: {
            ok: false,
            blocked: true,
            error: `команда заблокирована: ${screen.reason}. Выбери безопасный способ.`,
          },
        }
      }
      if (explanation) await log('agent', explanation)
      await log('command', redact(command))
      // Run inside the persistent working directory so `cd` carries across
      // commands (each SSH exec is a fresh shell otherwise). After the command
      // we print the resulting cwd behind a marker, read it back to update
      // state, and strip the marker line from what the model and log see.
      const wrapped = [
        `cd ${sh(state.cwd)} 2>/dev/null || cd ${sh(APPS_ROOT)} 2>/dev/null || cd /`,
        command,
        '__omnidesk_rc=$?',
        `printf '%s%s\\n' ${sh(CWD_MARKER)} "$(pwd)"`,
        'exit $__omnidesk_rc',
      ].join('\n')
      let nextCwd = state.cwd
      try {
        const res = await runStreaming(wrapped, (s, line) => {
          const captured = readCwdMarker(line)
          if (captured !== null) {
            if (captured) nextCwd = captured
            return // don't surface the marker line
          }
          void log(s, redact(line))
        })
        state.cwd = nextCwd
        const cleanOut = stripCwdMarker(res.stdout)
        return {
          payload: {
            ok: res.code === 0,
            exitCode: res.code,
            cwd: state.cwd,
            output: clampOutput(redact(cleanOut + (res.stderr ? `\n${res.stderr}` : ''))),
          },
        }
      } catch (err) {
        const msg = redact(err instanceof Error ? err.message : String(err))
        await log('stderr', msg)
        return { payload: { ok: false, error: msg } }
      }
    }

    case 'clone_repo': {
      const branch = String(args.branch ?? app.branch ?? 'main').trim() || 'main'
      const cloneUrl = buildCloneUrl(app.repo_url, token)
      // Build the command with the (possibly tokenized) URL, but NEVER log it —
      // announce a redacted version instead.
      // On a redeploy, snapshot the working copy to `<appDir>.prev` BEFORE
      // touching it, so "верни как было" (rollback) has something to restore —
      // including node_modules/build artifacts, making rollback instant.
      const prevDir = `${appDir}.prev`
      const command =
        `mkdir -p ${sh(APPS_ROOT)} && ` +
        `if [ -d ${sh(appDir)}/.git ]; then ` +
        `rm -rf ${sh(prevDir)} && cp -a ${sh(appDir)} ${sh(prevDir)} && ` +
        `cd ${sh(appDir)} && git remote set-url origin ${sh(cloneUrl)} && ` +
        `git fetch --all --prune && git checkout ${sh(branch)} && ` +
        `git reset --hard ${sh('origin/' + branch)}; ` +
        `else git clone --branch ${sh(branch)} ${sh(cloneUrl)} ${sh(appDir)}; fi`
      await log('agent', `Клонирую репозиторий (${redact(app.repo_url)}), ветка ${branch}.`)
      await log('command', `git clone/pull ${branch} → ${appDir}`)
      try {
        const res = await runStreaming(command)
        return {
          payload: {
            ok: res.code === 0,
            exitCode: res.code,
            path: appDir,
            output: clampOutput(redact(res.stdout + (res.stderr ? `\n${res.stderr}` : ''))),
          },
        }
      } catch (err) {
        const msg = redact(err instanceof Error ? err.message : String(err))
        await log('stderr', msg)
        return { payload: { ok: false, error: msg } }
      }
    }

    case 'upload_file': {
      const path = String(args.path ?? '').trim()
      const contents = String(args.contents ?? '')
      const explanation = String(args.explanation ?? '').trim()
      if (!path) return { payload: { ok: false, error: 'не указан путь' } }
      if (explanation) await log('agent', explanation)
      await log('command', `запись файла ${path} (${contents.length} байт)`)
      const delim = `OMNIDESK_EOF_${randomBytes(8).toString('hex')}`
      const dir = path.replace(/\/[^/]*$/, '') || '/'
      const cmd =
        `mkdir -p ${sh(dir)} && cat > ${sh(path)} <<'${delim}'\n${contents}\n${delim}`
      try {
        const res = await runStreaming(cmd)
        return { payload: { ok: res.code === 0, exitCode: res.code } }
      } catch (err) {
        const msg = redact(err instanceof Error ? err.message : String(err))
        return { payload: { ok: false, error: msg } }
      }
    }

    case 'set_status': {
      const phase = String(args.phase ?? '').trim()
      const note = String(args.note ?? '').trim()
      if (phase === 'cloning' || phase === 'building' || phase === 'running') {
        await repo.setDeploymentStatus(ctx.deploymentId, phase).catch(() => {})
      }
      if (note) await log('agent', note)
      return { payload: { ok: true } }
    }

    case 'finish': {
      const success = Boolean(args.success)
      const summary = String(args.summary ?? '').trim() || (success ? 'Готово.' : 'Не удалось.')
      const url = String(args.url ?? '').trim() || null
      const serverNotes = String(args.serverNotes ?? '').trim() || null
      const appNotes = String(args.appNotes ?? '').trim() || null
      return {
        payload: { ok: true },
        finish: { success, summary, url, serverNotes, appNotes },
      }
    }

    default:
      return { payload: { ok: false, error: `неизвестный инструмент: ${call.function.name}` } }
  }
}

/** Inject a token into an https GitHub URL for a private clone; else unchanged. */
function buildCloneUrl(repoUrl: string, token: string | null): string {
  if (!token) return repoUrl
  try {
    const u = new URL(repoUrl)
    if (u.protocol !== 'https:') return repoUrl
    // x-access-token works for GitHub PATs and app tokens.
    u.username = 'x-access-token'
    u.password = token
    return u.toString()
  } catch {
    return repoUrl
  }
}

/*
 * The model-facing surface (tool definitions, system prompt, user context)
 * lives in agent-prompts.ts.
 */
