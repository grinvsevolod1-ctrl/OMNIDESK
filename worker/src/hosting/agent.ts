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
  type ToolDef,
} from './gateway.js'

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

/** POSIX single-quote escaping so a value can't break out of the shell. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Terminal deployment states — the agent stops if it sees one (e.g. cancel). */
function isTerminal(status: string | null): boolean {
  return status === 'success' || status === 'failed' || status === null
}

/** The tools the model can call. */
function toolDefs(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          'Выполнить shell-команду на сервере по SSH (от текущего пользователя, обычно root). Используй для анализа сервера, установки пакетов, сборки и запуска. Опасные команды (удаление корня, форматирование, выключение) блокируются. Всегда сначала кратко объясни в поле explanation, что и зачем делаешь.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Команда для выполнения.' },
            explanation: {
              type: 'string',
              description: 'Короткое пояснение на русском, что делает команда.',
            },
          },
          required: ['command', 'explanation'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'clone_repo',
        description:
          'Склонировать (или обновить) репозиторий приложения в рабочую папку на сервере. Токен приватного репозитория подставляется автоматически на стороне сервера — тебе его знать не нужно. Возвращает путь к папке с кодом.',
        parameters: {
          type: 'object',
          properties: {
            branch: {
              type: 'string',
              description: 'Ветка (по умолчанию — ветка приложения).',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'upload_file',
        description:
          'Записать файл на сервер с заданным содержимым (например, nginx/Caddy-конфиг, systemd-юнит, Dockerfile, .env). Перезаписывает существующий файл.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Абсолютный путь к файлу.' },
            contents: { type: 'string', description: 'Содержимое файла.' },
            explanation: {
              type: 'string',
              description: 'Короткое пояснение, зачем этот файл.',
            },
          },
          required: ['path', 'contents'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_status',
        description:
          'Сообщить текущую фазу установки, чтобы админ видел прогресс. Вызывай при переходе к новому этапу.',
        parameters: {
          type: 'object',
          properties: {
            phase: {
              type: 'string',
              enum: ['cloning', 'building', 'running'],
              description:
                'cloning — получение кода, building — установка/сборка, running — запуск/проверка.',
            },
            note: { type: 'string', description: 'Короткое описание этапа.' },
          },
          required: ['phase'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish',
        description:
          'Завершить установку. success=true, если проект развёрнут и работает; success=false, если не удалось. Обязательно дай краткое резюме (summary) на русском: что сделано или почему не вышло. Если сайт доступен — укажи url.',
        parameters: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            summary: { type: 'string' },
            url: { type: 'string' },
            serverNotes: {
              type: 'string',
              description:
                'Короткая заметка о сервере на будущее (ОС, что уже установлено), чтобы ускорить следующие деплои.',
            },
          },
          required: ['success', 'summary'],
        },
      },
    },
  ]
}

interface AgentOutcome {
  success: boolean
  summary: string
  url: string | null
  serverNotes: string | null
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

    /** Stream a command's output to the log, redacting the token, with timeout. */
    const runStreaming = (command: string): Promise<ExecResult> => {
      return new Promise<ExecResult>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error(`команда превысила лимит ${AGENT_LIMITS.perCommandMs / 1000}с`))
        }, AGENT_LIMITS.perCommandMs)
        execStream(client, command, (s, line) => {
          void log(s, redact(line))
        }).then(
          (res) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(res)
          },
          (err) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        )
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
  log: (
    stream: 'stdout' | 'stderr' | 'system' | 'agent' | 'command',
    line: string,
  ) => Promise<void>
  redact: (s: string) => string
  runStreaming: (command: string) => Promise<ExecResult>
  client: SshConnection['client']
  startedAt: number
}): Promise<AgentOutcome> {
  const { app, server, appDir, deploymentId, token, log, redact, runStreaming } = ctx

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userContext(app, server, appDir) },
  ]

  for (let step = 0; step < AGENT_LIMITS.maxSteps; step++) {
    // Time budget.
    if (Date.now() - ctx.startedAt > AGENT_LIMITS.totalMs) {
      return {
        success: false,
        summary: 'Превышено общее время установки.',
        url: null,
        serverNotes: null,
      }
    }
    // Cooperative cancellation: admin may have cancelled the deployment.
    const status = await repo.getDeploymentStatus(deploymentId)
    if (isTerminal(status)) {
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
      return { success: false, summary: `Модель недоступна: ${msg}`, url: null, serverNotes: null }
    }

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
        token,
        log,
        redact,
        runStreaming,
        client: ctx.client,
      })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result.payload),
      })
      if (result.finish) return result.finish
    }
  }

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
    token: string | null
    log: (
      stream: 'stdout' | 'stderr' | 'system' | 'agent' | 'command',
      line: string,
    ) => Promise<void>
    redact: (s: string) => string
    runStreaming: (command: string) => Promise<ExecResult>
    client: SshConnection['client']
  },
): Promise<{ payload: unknown; finish?: AgentOutcome }> {
  const { app, appDir, token, log, redact, runStreaming } = ctx
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
      try {
        const res = await runStreaming(command)
        return {
          payload: {
            ok: res.code === 0,
            exitCode: res.code,
            output: clampOutput(redact(res.stdout + (res.stderr ? `\n${res.stderr}` : ''))),
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
      const command =
        `mkdir -p ${sh(APPS_ROOT)} && ` +
        `if [ -d ${sh(appDir)}/.git ]; then ` +
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
        await repo.setDeploymentStatus(ctx.appId ?? '', phase).catch(() => {})
      }
      if (note) await log('agent', note)
      return { payload: { ok: true } }
    }

    case 'finish': {
      const success = Boolean(args.success)
      const summary = String(args.summary ?? '').trim() || (success ? 'Готово.' : 'Не удалось.')
      const url = String(args.url ?? '').trim() || null
      const serverNotes = String(args.serverNotes ?? '').trim() || null
      return {
        payload: { ok: true },
        finish: { success, summary, url, serverNotes },
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

function systemPrompt(): string {
  return [
    'Ты — автономный DevOps-инженер, который разворачивает проекты на Linux-сервере по SSH. У тебя есть инструменты: run_command (выполнить команду), clone_repo (склонировать репозиторий приложения — токен подставляется автоматически), upload_file (записать файл), set_status (сообщить фазу), finish (завершить).',
    '',
    'ЦЕЛЬ: довести проект до рабочего состояния на сервере, полностью самостоятельно, шаг за шагом, пока не заработает. Действуй решительно и не спрашивай подтверждений — ты один на сервере.',
    '',
    'ПЛАН (адаптируй под проект):',
    '1. Определи ОС и дистрибутив (cat /etc/os-release, uname -a), какой пакетный менеджер (apt/dnf/yum/apk).',
    '2. Определи тип проекта по репозиторию (package.json → Node, Dockerfile → Docker, requirements.txt → Python, index.html → статика, composer.json → PHP и т.п.). Сначала set_status("cloning"), затем clone_repo, потом изучи файлы (ls, cat package.json).',
    '3. set_status("building"): установи недостающее (node+npm, docker, nginx/caddy, git, сборочные зависимости), затем установи зависимости проекта и собери его.',
    '4. set_status("running"): запусти приложение устойчиво (pm2 для Node/PHP, docker run --restart для Docker, либо systemd-юнит). Для статики — отдай через веб-сервер.',
    '5. Если задан домен — настрой reverse-proxy и HTTPS (Caddy проще всего: он сам берёт сертификат Let\'s Encrypt). Проверь, что сайт отвечает (curl -I).',
    '6. Вызови finish с итогом. Если сайт доступен — укажи url. Добавь serverNotes про ОС и установленное ПО.',
    '',
    'ПРАВИЛА:',
    '• Работай маленькими шагами: одна команда — одно понятное действие, с пояснением в explanation.',
    '• Всегда сначала проверяй (есть ли уже node? какой порт?), потом ставь. Не переустанавливай уже установленное.',
    '• Ставь пакеты неинтерактивно (DEBIAN_FRONTEND=noninteractive apt-get install -y …).',
    '• Если команда упала — прочитай вывод, пойми причину и исправь (другой пакет, sudo, нужный порт), не повторяй вслепую.',
    '• Никогда не выполняй разрушительных команд (удаление корня, форматирование, выключение) — они всё равно будут заблокированы.',
    '• Комментируй по-русски, коротко и по делу — админ читает это в живом логе.',
    '• Если после нескольких попыток заведомо нельзя продолжить (нет доступа, репозиторий не существует) — честно вызови finish(success=false) с причиной.',
  ].join('\n')
}

function userContext(
  app: repo.AppRecord,
  server: repo.ServerRecord,
  appDir: string,
): string {
  const lines = [
    `Сервер: ${server.name} (${server.ip_address}), пользователь ${server.ssh_username}.`,
    server.agent_notes ? `Заметки о сервере: ${server.agent_notes}` : 'Заметок о сервере пока нет.',
    `Репозиторий: ${app.repo_url}, ветка ${app.branch || 'main'}.`,
    app.domain ? `Домен для сайта: ${app.domain}.` : 'Домен не задан — reverse-proxy можно пропустить или слушать по IP.',
    app.port ? `Ожидаемый порт приложения: ${app.port}.` : '',
    app.repoToken ? 'Репозиторий приватный — используй clone_repo (токен подставится сам).' : 'Репозиторий публичный.',
    Object.keys(app.env).length > 0
      ? `Заданы переменные окружения: ${Object.keys(app.env).join(', ')} (запиши их в .env приложения через upload_file, значения ниже).`
      : 'Переменные окружения не заданы.',
    `Рабочая папка для кода: ${appDir}.`,
    '',
    'Начинай. Первым делом определи ОС и тип проекта.',
  ].filter(Boolean)
  // Env VALUES are needed so the agent can write the .env, but they're app
  // secrets already stored encrypted — include them only here in the worker's
  // model call, never in the deploy log.
  if (Object.keys(app.env).length > 0) {
    lines.push('', 'Значения переменных окружения (запиши в .env):')
    for (const [k, v] of Object.entries(app.env)) lines.push(`${k}=${v}`)
  }
  return lines.join('\n')
}
