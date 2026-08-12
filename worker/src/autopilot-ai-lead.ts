/**
 * AI-lead handler for messenger autopilot: when the AI is set to lead a
 * conversation (per-thread toggle) and the global assistant is enabled, it
 * generates a full contextual reply with the shared "brain" and sends it with
 * the same anti-ban pacing/caps as canned rules. Split out of autopilot.ts.
 *
 * Self-guarding by contract: fireAiLead never throws into the caller.
 */
import {
  assessLeadReady,
  type BrainLog,
  clientShowsReadinessSignal,
  detectEscalation,
  extractClientMemory,
  generateManagerReply,
} from '../../lib/ai/manager-brain.js'
import { assembleBrainInput } from '../../lib/ai/assemble-brain-input.js'
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
 * Conversations with an AI-lead generation currently in flight. A messenger
 * inbound can arrive while the model is still composing the previous reply;
 * without this guard both calls pass the pre-checks and the contact receives
 * two answers. We claim the conversation up-front and release it in a finally,
 * so only one AI reply is ever generated per conversation at a time.
 */
const aiLeadInFlight = new Set<string>()

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

  // Single-flight per conversation: if a reply is already being generated for
  // this thread, treat this inbound as handled (the in-flight generation will
  // answer) instead of starting a second one that would double-reply.
  // The claim MUST be taken synchronously (no await between has() and add()),
  // otherwise two concurrent inbounds can both pass the check and the contact
  // receives two answers — the exact race this guard exists to prevent.
  if (aiLeadInFlight.has(conversationId)) return true
  aiLeadInFlight.add(conversationId)

  try {
    if (!(await repo.isConversationAiLed(conversationId))) {
      void repo.logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'skip.not_led',
        message:
          'Диалог не ведётся ИИ (мастер-выключатель выключен или диалог на паузе) — пропускаю.',
        conversationId,
        channelType,
      })
      return false
    }
    const config = await repo.getAiAssistConfig()
    if (!config.enabled) {
      void repo.logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'skip.master_off',
        message: 'Мастер-выключатель ИИ выключен — ответ не отправляется.',
        conversationId,
        channelType,
      })
      return false
    }
    if (!(await withinRateCaps(channelId))) {
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
    }

    void repo.logAi({
      level: 'debug',
      source: 'ai-lead',
      event: 'inbound',
      message: 'Новое сообщение клиента в мессенджере — готовлю ответ.',
      conversationId,
      channelType,
    })

    // Single source of truth for the brain's input context (limits, RAG query
    // choice) — shared with the livechat and follow-up runtimes. Directives
    // ride in via the config's 30s TTL cache instead of a fresh query.
    const { lessons, corrections, history, memory, knowledge, directives } =
      await assembleBrainInput(
        conversationId,
        workerBrainLoaders(config.directives),
      )

    // Escalation guard: angry client / demands a human / stuck dialog → hand off
    // to a person via the handoff path (status → «Передан человеку») instead of
    // auto-replying.
    const escalation = await detectEscalation(history, log, {
      model: config.model,
    })
    if (escalation.escalate) {
      const promoted = await repo.markAiHandoffToHuman(conversationId)
      void repo.logAi({
        level: 'info',
        source: 'handoff',
        event: 'escalated',
        message: promoted
          ? `ИИ передал диалог человеку (эскалация): ${escalation.reason || 'причина не указана'}.`
          : `Эскалация (${escalation.reason || '—'}), но статус уже задан вручную — ИИ просто замолкает.`,
        conversationId,
        channelType,
      })
      return true
    }

    // A/B: overlay the active experiment for this conversation's branch.
    // Deterministic hash — agrees with the panel and follow-up paths, so a
    // client stays on one branch across every channel. Fail-open by contract.
    const exp = await repo.applyActiveExperiment(
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
      log,
      {
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        selfCritique: true,
      },
    )
    if (!reply) {
      void repo.logAi({
        level: 'warn',
        source: 'ai-lead',
        event: 'no_reply',
        message: 'ИИ не сформировал ответ — клиенту ничего не отправлено.',
        conversationId,
        channelType,
      })
      return false
    }

    // Human-like pacing: hold typing presence for a length-scaled delay.
    const delayMs = Math.min(
      45_000,
      3000 + reply.length * 60 + Math.floor(Math.random() * 4000),
    )
    await typeWhileWaiting(session, contactHandle, delayMs)

    // Re-check the AI-lead flag right before sending: a human may have taken
    // over (manual reply clears the flag) while we were composing. If so, bail
    // out so the AI doesn't talk over the human.
    if (!(await repo.isConversationAiLed(conversationId))) {
      if (session.sendTyping) {
        await session.sendTyping(contactHandle, false).catch(() => {})
      }
      logger.info(
        { channelId, conversationId },
        'ai-lead: human took over during generation, skipping send',
      )
      void repo.logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'handover.during_gen',
        message:
          'Пока ИИ готовил ответ, в диалог вошёл человек — отправка отменена.',
        conversationId,
        channelType,
      })
      return true
    }

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
    void repo.logAi({
      level: 'info',
      source: 'ai-lead',
      event: 'reply.sent',
      message: `Ответ отправлен клиенту: "${reply.slice(0, 200)}"`,
      conversationId,
      channelType,
    })

    // Refresh durable client memory (best-effort, fire and forget).
    void (async () => {
      try {
        const nextHistory = [
          ...history,
          { role: 'manager' as const, body: reply },
        ]
        const summary = await extractClientMemory(
          nextHistory,
          memory,
          log,
          { model: config.model },
        )
        if (summary !== null) {
          await repo.saveConversationAiMemory(
            conversationId,
            summary,
            nextHistory.filter((m) => m.role === 'client').length,
          )
        }
      } catch (err) {
        logger.error({ err, conversationId }, 'ai-lead: memory update failed')
      }
    })()

    // After replying, judge whether the client is ready to hand over their data
    // and start working. If so, move the lead to «Передан человеку» and hand it
    // to a human (pauses the AI + flags the panel banner). The «Ликвид» call is
    // a manager decision, never automatic. Best-effort — never let a promotion
    // failure affect the reply we already delivered.
    //
    // Cost guard (identical to the live-chat runtime): the readiness check is a
    // second gateway call on every turn, so skip it until the client's own
    // recent messages actually show a readiness signal. Keeps both runtimes in
    // lockstep on behaviour and spend.
    try {
      if (!clientShowsReadinessSignal(history)) {
        return true
      }
      const ready = await assessLeadReady(
        [...history, { role: 'manager', body: reply }],
        log,
        { model: config.model },
      )
      if (ready) {
        const promoted = await repo.markAiHandoffToHuman(conversationId)
        if (promoted) {
          logger.info({ channelId, conversationId }, 'ai-lead: handed lead to a human («Передан человеку»)')
          void repo.logAi({
            level: 'info',
            source: 'handoff',
            event: 'promoted',
            message:
              'ИИ передал лид человеку: статус изменён на «Передан человеку», ИИ поставлен на паузу. Классификацию «Ликвид» менеджер выставляет вручную.',
            conversationId,
            channelType,
          })
        }
      }
    } catch (err) {
      logger.error({ err, channelId, conversationId }, 'ai-lead: readiness check failed (ignored)')
    }
    return true
  } catch (err) {
    logger.error({ err, channelId, conversationId }, 'ai-lead: failed (ignored)')
    void repo.logAi({
      level: 'error',
      source: 'ai-lead',
      event: 'error',
      message: `Сбой ИИ-лида: ${err instanceof Error ? err.message : String(err)}`,
      conversationId,
      channelType,
    })
    return false
  } finally {
    aiLeadInFlight.delete(conversationId)
  }
}
