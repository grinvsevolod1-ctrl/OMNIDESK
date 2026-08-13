/**
 * AI-lead handler for messenger autopilot: when the AI is set to lead a
 * conversation (per-thread toggle) and the global assistant is enabled, it
 * generates a full contextual reply with the shared "brain" and sends it with
 * the same anti-ban pacing/caps as canned rules. Split out of autopilot.ts.
 *
 * The pipeline itself (single-flight + dirty re-run, escalation, A/B overlay,
 * generation, handover re-check, memory, readiness) lives in
 * lib/ai/ai-lead-run.ts and is shared with the live-chat runtime; this
 * adapter only wires in messenger I/O (pacing, typing presence, provider
 * send, rate caps).
 *
 * Self-guarding by contract: fireAiLead never throws into the caller.
 */
import { type BrainLog } from '../../lib/ai/manager-brain.js'
import { assembleBrainInput } from '../../lib/ai/assemble-brain-input.js'
import { runAiLead } from '../../lib/ai/ai-lead-run.js'
import { workerBrainLoaders } from './brain-loaders.js'
import { logger } from './logger.js'
import * as repo from './repo.js'
import {
  noteAutopilotSend,
  typeWhileWaiting,
  withinRateCaps,
  type SenderSession,
} from './autopilot-pacing.js'

/**
 * Returns true when it handled the inbound (so the caller skips canned rules
 * and avoids double-answering).
 */
export async function fireAiLead(params: {
  session: SenderSession
  channelId: string
  managerId: string
  channelType: 'telegram' | 'whatsapp'
  conversationId: string
  contactHandle: string
}): Promise<boolean> {
  const { session, channelId, managerId, channelType, conversationId, contactHandle } =
    params

  // Diagnostics sink → shared ai_logs table → panel "Логи" tab.
  const log: BrainLog = (e) => {
    void repo.logAi({
      level: e.level,
      source: 'brain',
      event: e.event,
      message: e.message,
      conversationId,
      channelType,
      meta: e.meta ?? null,
    })
    // Durable A/B metrics on the brain's per-call metric event.
    if (e.event === 'gateway.metrics' && e.meta) {
      const m = e.meta as Record<string, unknown>
      void repo.recordAiGenerationMetric({
        model: String(m.model ?? ''),
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
        conversationId,
      })
    }
  }

  return runAiLead(conversationId, {
    log,
    logAi: (e) => {
      void repo.logAi({
        level: e.level,
        source: e.source,
        event: e.event,
        message: e.message,
        conversationId,
        channelType,
      })
    },
    isConversationAiLed: repo.isConversationAiLed,
    getConfig: () => repo.getAiAssistConfig(),
    afterConfigCheck: async () => {
      if (await withinRateCaps(channelId)) return true
      void repo.logAi({
        level: 'warn',
        source: 'ai-lead',
        event: 'skip.rate_cap',
        message:
          'Достигнут анти-бан лимит отправок по каналу — ответ отложен.',
        conversationId,
        channelType,
      })
      return false
    },
    // Directives ride in via the config's 30s TTL cache instead of a fresh
    // query. No explicit queryText: the RAG query falls back to the newest
    // client message in history, which keeps dirty re-runs fresh too.
    assembleInput: async (convId) => {
      const config = await repo.getAiAssistConfig()
      return assembleBrainInput(convId, workerBrainLoaders(config.directives))
    },
    applyExperiment: repo.applyActiveExperiment,
    markAiHandoffToHuman: repo.markAiHandoffToHuman,
    saveConversationAiMemory: repo.saveConversationAiMemory,
    // Human-like pacing: hold typing presence for a length-scaled delay.
    beforeSend: async (reply) => {
      const delayMs = Math.min(
        45_000,
        3000 + reply.length * 60 + Math.floor(Math.random() * 4000),
      )
      await typeWhileWaiting(session, contactHandle, delayMs)
    },
    onSendCancelled: async () => {
      if (session.sendTyping) {
        await session.sendTyping(contactHandle, false).catch(() => {})
      }
      logger.info(
        { channelId, conversationId },
        'ai-lead: human took over during generation, skipping send',
      )
    },
    send: async (_convId, reply) => {
      const { providerMessageId } = await session.sendMessage(contactHandle, reply)
      noteAutopilotSend(channelId)
      await repo.ingestInbound({
        channelId,
        managerId,
        channelType,
        contactName: contactHandle,
        contactHandle,
        body: reply,
        direction: 'out',
        author: 'ИИ-ассистент',
        providerMessageId,
        isAutopilot: true,
      })
      logger.info({ channelId, conversationId }, 'ai-lead: auto-reply sent')
    },
    inboundLogMessage: 'Новое сообщение клиента в мессенджере — готовлю ответ.',
    onPromoted: () =>
      logger.info(
        { channelId, conversationId },
        'ai-lead: handed lead to a human («Передан человеку»)',
      ),
    onError: (err) =>
      logger.error({ err, channelId, conversationId }, 'ai-lead: failed (ignored)'),
    onBackgroundError: (stage, err) =>
      logger.error(
        { err, channelId, conversationId },
        stage === 'memory'
          ? 'ai-lead: memory update failed'
          : 'ai-lead: readiness check failed (ignored)',
      ),
  })
}
