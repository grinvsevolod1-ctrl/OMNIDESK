import 'server-only'
import { query } from '../db'
import { addMessage, getLivechatWorkingHoursByChannelId } from '../data'
import { applyActiveExperiment } from '../data/ai-experiments'
import {
  getAiAssistSettings,
  isConversationAiLed,
  markAiHandoffToHuman,
  recordAiGenerationMetric,
  saveConversationAiMemory,
} from '../data/ai-assist'
import { assembleBrainInput } from '../ai/assemble-brain-input'
import { dataBrainLoaders } from '../data/brain-loaders'
import { runAiLead } from '../ai/ai-lead-run'
import { type BrainLog, isBrainConfigured } from '../ai/manager-brain'
import { logAi } from '../data/ai-log'
import { deliverOutboundByChannel } from '../outbound-dispatch'
import { isOffHoursFor } from '../offhours'
import {
  getActiveAutopilot,
  tryRecordFire,
} from './data'
import {
  type MatchInput,
  ruleRequiresDedupe,
  selectRule,
} from './match'

/**
 * Autopilot runtime for LIVE-CHAT inbound (runs inside the Next.js ingest
 * route). Messenger inbound (Telegram/WhatsApp) is handled separately in the
 * worker, which shares the same pure matcher (lib/autopilot/match.ts) and the
 * same AI-lead pipeline (lib/ai/ai-lead-run.ts).
 *
 * Given a freshly-recorded inbound message, this:
 *   1. loads the manager's active autopilot (master switch + enabled rules),
 *   2. evaluates rules (event + keyword + working-hours + source conditions),
 *   3. dedupes via autopilot_fires, and
 *   4. sends the first matching rule's reply as an outbound message.
 *
 * Live-chat has no ban risk, so the reply is sent near-instantly (no pacing).
 * Best-effort: any error is swallowed so an autopilot failure can never break
 * message ingestion.
 */
export async function runLivechatAutopilot(input: {
  managerId: string
  channelId: string
  conversationId: string
  text: string
}): Promise<void> {
  try {
    // AI-lead takes priority: if the AI is set to lead this conversation, let
    // it generate a full contextual reply and skip the canned-rule engine so
    // the two never both answer.
    const handledByAi = await runLivechatAiLead(input)
    if (handledByAi) return

    const { enabled, rules } = await getActiveAutopilot(input.managerId)
    if (!enabled || rules.length === 0) return

    // Is this the first inbound of the conversation? (recordLivechatInbound has
    // already inserted it, so a count of exactly 1 means it's the first.)
    const inboundRows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM messages
        WHERE conversation_id = $1 AND direction = 'in'`,
      [input.conversationId],
    )
    const isFirstMessage = Number(inboundRows[0]?.n ?? 0) <= 1

    // Only resolve working hours if at least one rule actually needs them.
    let insideWorkingHours: boolean | null = null
    const needsWorkingHours = rules.some(
      (r) => r.config.requireWorkingHours !== 'any',
    )
    if (needsWorkingHours) {
      const wh = await getLivechatWorkingHoursByChannelId(input.channelId)
      insideWorkingHours = wh ? !isOffHoursFor(wh) : null
    }

    const matchInput: MatchInput = {
      mode: 'inbound',
      text: input.text,
      channelId: input.channelId,
      isFirstMessage,
      insideWorkingHours,
    }

    const rule = selectRule(rules, matchInput)
    if (!rule) return

    const replyText = rule.config.replyText.trim()
    if (!replyText) return

    // Dedupe: claim the fire before sending so concurrent inbounds can't
    // double-send. If the claim fails the rule already fired on this conv.
    if (ruleRequiresDedupe(rule)) {
      const claimed = await tryRecordFire(rule.id, input.conversationId)
      if (!claimed) return
    }

    await sendAutoReply(input.managerId, input.conversationId, replyText)
  } catch (err) {
    console.error('autopilot(livechat) failed:', err)
  }
}

/**
 * AI-lead for live chat: when the AI is set to lead THIS conversation and the
 * global assistant is enabled, generate a full contextual reply with the shared
 * brain and send it as an outbound message authored as the AI. Returns true
 * when it handled the inbound (so canned rules are skipped). Best-effort — any
 * failure returns false so canned autopilot can still try.
 *
 * The pipeline itself (single-flight + dirty re-run, escalation, A/B overlay,
 * generation, handover re-check, memory, readiness) lives in
 * lib/ai/ai-lead-run.ts and is shared with the worker; this adapter only wires
 * in live-chat I/O.
 */
async function runLivechatAiLead(input: {
  managerId: string
  channelId: string
  conversationId: string
  text: string
}): Promise<boolean> {
  // Diagnostics sink for this conversation — everything lands in the panel
  // "Логи" tab tagged to this thread/channel.
  const log: BrainLog = (e) => {
    void logAi({
      level: e.level,
      source: 'brain',
      event: e.event,
      message: e.message,
      conversationId: input.conversationId,
      channelType: 'livechat',
      meta: e.meta ?? null,
    })
    // Persist durable A/B metrics on the brain's per-call metric event.
    if (e.event === 'gateway.metrics' && e.meta) {
      const m = e.meta as Record<string, unknown>
      void recordAiGenerationMetric({
        model: String(m.model ?? ''),
        runtime: 'livechat',
        purpose: (m.purpose as 'reply' | 'assess') ?? 'reply',
        outcome:
          (m.outcome as
            | 'ok'
            | 'empty'
            | 'refused'
            | 'http_error'
            | 'exception') ?? 'ok',
        latencyMs: typeof m.latencyMs === 'number' ? m.latencyMs : null,
        promptTokens: typeof m.promptTokens === 'number' ? m.promptTokens : null,
        completionTokens:
          typeof m.completionTokens === 'number' ? m.completionTokens : null,
        conversationId: input.conversationId,
      })
    }
  }

  return runAiLead(input.conversationId, {
    log,
    logAi: (e) => {
      void logAi({
        level: e.level,
        source: e.source,
        event: e.event,
        message: e.message,
        conversationId: input.conversationId,
        channelType: 'livechat',
      })
    },
    precheck: async () => {
      if (isBrainConfigured()) return true
      void logAi({
        level: 'error',
        source: 'ai-lead',
        event: 'skip.no_key',
        message:
          'ИИ не настроен: отсутствует AI_GATEWAY_API_KEY. Ответы не отправляются.',
        conversationId: input.conversationId,
        channelType: 'livechat',
      })
      return false
    },
    isConversationAiLed,
    getConfig: () => getAiAssistSettings(),
    // No explicit queryText: the inbound is already recorded, so the RAG query
    // falls back to the NEWEST client message in history — which also keeps
    // dirty re-runs querying against the latest message, not a stale capture.
    assembleInput: (conversationId) =>
      assembleBrainInput(conversationId, dataBrainLoaders),
    applyExperiment: applyActiveExperiment,
    markAiHandoffToHuman,
    saveConversationAiMemory,
    send: (conversationId, reply) =>
      sendAiReply(input.managerId, conversationId, reply),
    inboundLogMessage: `Новое сообщение клиента: "${input.text.slice(0, 200)}" — готовлю ответ.`,
    onError: (err) => console.error('autopilot(livechat) AI-lead failed:', err),
    onBackgroundError: (stage, err) =>
      console.error(
        stage === 'memory'
          ? 'autopilot(livechat) memory update failed:'
          : 'autopilot(livechat) readiness check failed:',
        err,
      ),
  })
}

/** Send an AI-authored reply, keeping the AI-lead flag on (byAi). */
async function sendAiReply(
  managerId: string,
  conversationId: string,
  body: string,
): Promise<void> {
  const msg = await addMessage({
    conversationId,
    managerId,
    body,
    author: 'ИИ-ассистент',
    byAi: true,
  })
  if (msg) {
    await deliverOutboundByChannel(conversationId, msg.id, body)
  }
}

/**
 * Manager display names, cached with a short TTL: sendAutoReply used to hit
 * the DB for the same name on every canned-rule fire. Names change rarely;
 * 30s staleness is invisible to visitors and matches the brain-config cache.
 */
const managerNameCache = new Map<string, { name: string; expiresAt: number }>()
const MANAGER_NAME_TTL_MS = 30_000

async function getManagerDisplayName(managerId: string): Promise<string> {
  const now = Date.now()
  const cached = managerNameCache.get(managerId)
  if (cached && cached.expiresAt > now) return cached.name
  const nameRows = await query<{ name: string }>(
    'SELECT name FROM managers WHERE id = $1',
    [managerId],
  )
  const name = nameRows[0]?.name?.trim() || 'Поддержка'
  managerNameCache.set(managerId, { name, expiresAt: now + MANAGER_NAME_TTL_MS })
  return name
}

/** Send the auto-reply as an outbound message authored by the manager. */
async function sendAutoReply(
  managerId: string,
  conversationId: string,
  body: string,
): Promise<void> {
  // Author with the manager's display name so the visitor sees a normal reply.
  const author = await getManagerDisplayName(managerId)
  // addMessage inserts the outbound row; the DB notify trigger delivers it to
  // both the widget (SSE) and the manager's inbox in real time.
  // byAi: automated sends must not clear the AI-lead flag (only a human reply
  // does). Canned autopilot is automated, so mark it accordingly.
  const msg = await addMessage({ conversationId, managerId, body, author, byAi: true })
  // Webhook-based channels have no SSE widget — the reply must be pushed to the
  // provider. Routed by channel type in one lookup (livechat needs no push).
  if (msg) {
    await deliverOutboundByChannel(conversationId, msg.id, body)
  }
}
