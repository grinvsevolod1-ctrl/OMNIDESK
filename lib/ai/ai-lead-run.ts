/**
 * Shared AI-lead orchestrator — the single reply pipeline used by BOTH
 * runtimes:
 *   - the Next.js live-chat ingest route (lib/autopilot/runtime.ts)
 *   - the standalone messenger worker (worker/src/autopilot-ai-lead.ts)
 *
 * The sequence "single-flight → pre-checks → assemble input → escalation →
 * A/B overlay → generate → re-check AI-lead → send → memory refresh →
 * readiness check" used to be duplicated (nearly line-for-line) in both
 * runtimes; any behaviour change had to be synchronized by hand. This module
 * is now the single source of truth for the ORDER and SEMANTICS of the
 * pipeline, with all runtime-specific I/O injected via `AiLeadRunDeps` —
 * the same dependency-injection pattern as assemble-brain-input.ts.
 *
 * Dependency rules: no `server-only`, no database, no `@/` aliases — the
 * worker imports this via a relative `.js` path just like manager-brain.
 *
 * SINGLE-FLIGHT + DIRTY RE-RUN
 * A second inbound can arrive while the model is still composing. Without a
 * guard both calls pass the pre-checks and the client receives two answers;
 * with a bare "drop it" guard the second message is silently IGNORED (the
 * in-flight generation assembled its history before that message existed).
 * So the guard marks the flight "dirty" instead: after the current reply is
 * delivered the pipeline re-runs once with FRESH history, answering whatever
 * arrived mid-generation. Bounded to MAX_DIRTY_RERUNS so a rapid-fire client
 * can never pin the model in a loop.
 */

import cluster from 'node:cluster'
import type { AssembledBrainInput } from './assemble-brain-input'
import {
  assessLeadReady,
  clientShowsReadinessSignal,
  detectEscalation,
  extractClientMemory,
  generateManagerReply,
  type BrainLog,
} from './manager-brain'

/** The subset of the assistant settings the pipeline needs (both runtimes' config shapes satisfy it structurally). */
export interface AiLeadRunConfig {
  enabled: boolean
  persona: string
  tone: string
  playbook: string[]
  aggressiveness: number
  model: string
  temperature: number
  maxTokens: number
}

/** A durable ai_logs entry; the runtime adapter stamps conversation/channel. */
export interface AiLeadLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  source: 'ai-lead' | 'handoff'
  event: string
  message: string
}

export interface AiLeadRunDeps {
  /** Brain diagnostics sink (also feeds durable A/B metrics in the adapter). */
  log: BrainLog
  /** Durable panel log ("Логи" tab); adapter adds conversationId/channelType. */
  logAi: (entry: AiLeadLogEntry) => void
  isConversationAiLed: (conversationId: string) => Promise<boolean>
  getConfig: () => Promise<AiLeadRunConfig>
  /**
   * Assemble the brain input for this conversation. Called FRESH on every
   * (re-)run so a dirty re-run sees the messages that arrived mid-generation.
   * The RAG query should come from the newest client message in history (the
   * assembler's fallback), not a captured inbound text, for the same reason.
   */
  assembleInput: (conversationId: string) => Promise<AssembledBrainInput>
  /** A/B experiment overlay (fail-open by contract in both runtimes). */
  applyExperiment: (
    base: { persona: string; tone: string; aggressiveness: number },
    conversationId: string,
  ) => Promise<{
    settings: { persona: string; tone: string; aggressiveness: number }
    extraDirectives: string[]
  }>
  markAiHandoffToHuman: (conversationId: string) => Promise<boolean>
  saveConversationAiMemory: (
    conversationId: string,
    summary: string,
    clientMessageCount: number,
  ) => Promise<void>
  /**
   * Runs before anything else; return false to bail out UNHANDLED (canned
   * rules may still run). Logging the reason is the hook's job.
   * Live-chat: isBrainConfigured. Worker: unused.
   */
  precheck?: () => Promise<boolean>
  /**
   * Runs after the master-switch check; return false to bail out UNHANDLED.
   * Worker: anti-ban rate caps (re-checked on dirty re-runs too).
   */
  afterConfigCheck?: (config: AiLeadRunConfig) => Promise<boolean>
  /** Human-like pacing before the send (worker holds typing presence here). */
  beforeSend?: (reply: string) => Promise<void>
  /** A human took over mid-generation — undo presence (stop typing) etc. */
  onSendCancelled?: () => Promise<void>
  /** Deliver the reply to the client and persist the outbound message. */
  send: (conversationId: string, reply: string) => Promise<void>
  /** Runtime-flavoured "new inbound" debug line. */
  inboundLogMessage: string
  /** Lead promoted to «Передан человеку» after the readiness check. */
  onPromoted?: () => void
  /** Pipeline failed (already logged durably); runtime console/pino output. */
  onError: (err: unknown) => void
  /** A best-effort background stage failed (reply already delivered). */
  onBackgroundError: (stage: 'memory' | 'readiness', err: unknown) => void
}

/**
 * Conversations with a generation in flight, with the dirty flag for inbounds
 * that arrived mid-generation. Module-scoped (per Node process) — see the
 * single-process guard below.
 */
const inFlight = new Map<string, { dirty: boolean }>()

/** Upper bound on dirty re-runs per flight (rapid-fire clients can't loop us). */
const MAX_DIRTY_RERUNS = 2

/**
 * The in-flight map is only correct for a SINGLE process per runtime: with N
 * instances each guards independently and a client can receive N answers.
 * Same failure mode lib/rate-limit.ts protects against for its counters. pm2
 * cluster mode runs the app as Node `cluster` workers, so `cluster.isWorker`
 * is true there and ONLY there (NODE_APP_INSTANCE is set even for single
 * fork-mode processes — not a valid signal). Duplicate replies are a product
 * bug rather than a security hole, so this logs loudly instead of throwing.
 */
let multiProcessChecked = false
function warnIfMultiProcess(): void {
  if (multiProcessChecked) return
  multiProcessChecked = true
  if (cluster.isWorker !== true) return
  console.error(
    '[ai-lead] Multiple app instances detected (pm2 cluster mode). The ' +
      'per-conversation single-flight guard is per-process, so concurrent ' +
      'inbounds can produce DUPLICATE AI replies across instances. Run this ' +
      'runtime as a single instance (pm2 fork mode).',
  )
}

/**
 * Run the AI-lead pipeline for one inbound. Returns true when the inbound was
 * handled (reply sent, escalated, or absorbed by an in-flight generation) so
 * the caller skips canned rules; false when the AI declined (not configured /
 * not led / disabled / rate-capped / no reply) and canned rules may still run.
 *
 * Never throws: failures are logged durably, reported via deps.onError, and
 * surface as `false`.
 */
export async function runAiLead(
  conversationId: string,
  deps: AiLeadRunDeps,
): Promise<boolean> {
  warnIfMultiProcess()

  // Single-flight per conversation. The claim MUST be taken synchronously
  // (no await between get() and set()), otherwise two concurrent inbounds can
  // both pass the check and the client receives two answers. A second inbound
  // during a flight marks it dirty so the pipeline re-runs with fresh history
  // instead of silently ignoring the message.
  const existing = inFlight.get(conversationId)
  if (existing) {
    existing.dirty = true
    return true
  }
  const flight = { dirty: false }
  inFlight.set(conversationId, flight)

  try {
    let handled = await runOnce(conversationId, deps)
    // Messages arrived while we were composing: answer them too, with freshly
    // assembled history. Only when the first pass actually handled the inbound
    // (otherwise the AI is off/paused for this thread and a re-run is a no-op).
    for (let rerun = 0; flight.dirty && handled && rerun < MAX_DIRTY_RERUNS; rerun++) {
      flight.dirty = false
      deps.logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'rerun.dirty',
        message:
          'Пока ИИ готовил ответ, клиент написал ещё — формирую ответ на новые сообщения.',
      })
      handled = await runOnce(conversationId, deps)
    }
    return handled
  } finally {
    inFlight.delete(conversationId)
  }
}

/** One pass of the pipeline. Throws are contained here (durable log + onError). */
async function runOnce(
  conversationId: string,
  deps: AiLeadRunDeps,
): Promise<boolean> {
  try {
    if (deps.precheck && !(await deps.precheck())) return false

    if (!(await deps.isConversationAiLed(conversationId))) {
      deps.logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'skip.not_led',
        message:
          'Диалог не ведётся ИИ (мастер-выключатель выключен или диалог на паузе) — пропускаю.',
      })
      return false
    }
    const config = await deps.getConfig()
    if (!config.enabled) {
      deps.logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'skip.master_off',
        message: 'Мастер-выключатель ИИ выключен — ответ не отправляется.',
      })
      return false
    }
    if (deps.afterConfigCheck && !(await deps.afterConfigCheck(config))) {
      return false
    }

    deps.logAi({
      level: 'debug',
      source: 'ai-lead',
      event: 'inbound',
      message: deps.inboundLogMessage,
    })

    // Single source of truth for the brain's input context — fresh each pass.
    const { lessons, corrections, history, memory, knowledge, directives } =
      await deps.assembleInput(conversationId)

    // Escalation guard: angry client / demands a human / stuck dialog → hand
    // off to a person via the handoff path (status → «Передан человеку»)
    // instead of auto-replying. Heuristically pre-filtered inside
    // detectEscalation so the (paid) model call only runs on real signals.
    const escalation = await detectEscalation(history, deps.log, {
      model: config.model,
    })
    if (escalation.escalate) {
      const promoted = await deps.markAiHandoffToHuman(conversationId)
      deps.logAi({
        level: 'info',
        source: 'handoff',
        event: 'escalated',
        message: promoted
          ? `ИИ передал диалог человеку (эскалация): ${escalation.reason || 'причина не указана'}.`
          : `Эскалация (${escalation.reason || '—'}), но статус уже задан вручную — ИИ просто замолкает.`,
      })
      return true
    }

    // A/B: overlay the active experiment for this conversation's branch.
    // Deterministic hash — a client stays on one branch across every channel.
    // Fail-open by contract: an experiment can never block replying.
    const exp = await deps.applyExperiment(
      {
        persona: config.persona,
        tone: config.tone,
        aggressiveness: config.aggressiveness,
      },
      conversationId,
    )

    const reply = await generateManagerReply(
      {
        persona: exp.settings.persona,
        tone: exp.settings.tone,
        playbook: config.playbook,
        directives: [...exp.extraDirectives, ...directives],
        lessons,
        corrections,
        memory,
        knowledge,
        aggressiveness: exp.settings.aggressiveness,
        history,
      },
      deps.log,
      {
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        selfCritique: true,
      },
    )
    if (!reply) {
      deps.logAi({
        level: 'warn',
        source: 'ai-lead',
        event: 'no_reply',
        message: 'ИИ не сформировал ответ — клиенту ничего не отправлено.',
      })
      return false
    }

    // Human-like pacing (worker holds typing presence for a scaled delay).
    if (deps.beforeSend) await deps.beforeSend(reply)

    // Re-check the AI-lead flag right before sending: a human may have sent a
    // manual reply (which clears the flag) while we were composing. If so,
    // bail out so the AI doesn't talk over the human.
    if (!(await deps.isConversationAiLed(conversationId))) {
      if (deps.onSendCancelled) await deps.onSendCancelled()
      deps.logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'handover.during_gen',
        message:
          'Пока ИИ готовил ответ, в диалог вошёл человек — отправка отменена.',
      })
      return true
    }

    await deps.send(conversationId, reply)
    deps.logAi({
      level: 'info',
      source: 'ai-lead',
      event: 'reply.sent',
      message: `Ответ отправлен клиенту: "${reply.slice(0, 200)}"`,
    })

    // Refresh durable client memory in the background (best-effort, fire and
    // forget — must never delay or fail the reply we already sent).
    void (async () => {
      try {
        const nextHistory = [
          ...history,
          { role: 'manager' as const, body: reply },
        ]
        const summary = await extractClientMemory(nextHistory, memory, deps.log, {
          model: config.model,
        })
        if (summary !== null) {
          await deps.saveConversationAiMemory(
            conversationId,
            summary,
            nextHistory.filter((m) => m.role === 'client').length,
          )
        }
      } catch (err) {
        deps.onBackgroundError('memory', err)
      }
    })()

    // After replying, judge whether the client is now ready to hand over their
    // data and start working. If so, move the lead to «Передан человеку» and
    // hand it to a human (pauses the AI + flags the inbox banner). The «Ликвид»
    // call is a manager decision, never automatic. Best-effort: never let a
    // promotion failure affect the reply we already sent.
    //
    // Cost guard: the readiness check is a second gateway call on every turn,
    // so we skip it entirely until the client's own recent messages actually
    // show a readiness signal (agreement / sharing contacts).
    try {
      if (!clientShowsReadinessSignal(history)) {
        return true
      }
      const ready = await assessLeadReady(
        [...history, { role: 'manager', body: reply }],
        deps.log,
        { model: config.model },
      )
      if (ready) {
        const promoted = await deps.markAiHandoffToHuman(conversationId)
        if (promoted) {
          deps.onPromoted?.()
          deps.logAi({
            level: 'info',
            source: 'handoff',
            event: 'promoted',
            message:
              'ИИ передал лид человеку: статус изменён на «Передан человеку», ИИ поставлен на паузу. Классификацию «Ликвид» менеджер выставляет вручную.',
          })
        }
      }
    } catch (err) {
      deps.onBackgroundError('readiness', err)
    }
    return true
  } catch (err) {
    deps.onError(err)
    deps.logAi({
      level: 'error',
      source: 'ai-lead',
      event: 'error',
      message: `Сбой ИИ-лида: ${err instanceof Error ? err.message : String(err)}`,
    })
    return false
  }
}
