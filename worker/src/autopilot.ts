/**
 * Autopilot for messenger channels (Telegram / WhatsApp), running inside the
 * standalone worker process.
 *
 * Two entry points:
 *   - onInbound(): called right after a messenger inbound is persisted. Covers
 *     the 'first_message' and 'any_message' events.
 *   - runNoResponseSweep(): called on a timer from index.ts. Covers the
 *     'no_response' event (inbound left unanswered by a human for N minutes).
 *
 * Reuses the SHARED pure matcher in lib/autopilot/match.ts (imported by relative
 * path so tsx resolves it from the repo root), so messenger and live-chat apply
 * identical rule logic. Everything here is self-guarding: any failure is logged
 * and swallowed so autopilot can never break message ingestion or the worker.
 *
 * Anti-ban posture for messengers (web/live-chat has no ban risk and is handled
 * separately in the Next.js runtime):
 *   - human-like delay before sending (base + jitter + simulated typing), with
 *     a "typing…" presence shown during the wait when the provider supports it;
 *   - a per-channel cooldown so a burst of inbounds can't trigger a burst of
 *     auto-sends;
 *   - per-channel rate caps (hour/day) on auto-sends only;
 *   - group / non-direct chats are never auto-answered (caller already filters
 *     groups for WhatsApp; Telegram passes only private chats here).
 */
import {
  normalizeEvent,
  normalizeRuleConfig,
  selectRule,
  ruleRequiresDedupe,
  computeSendDelayMs,
  type AutopilotRule,
  type MatchInput,
} from '../../lib/autopilot/match.js'
import { isOffHoursFor, type WorkingHoursLike } from '../../lib/offhours.js'
import {
  assessLeadReady,
  type BrainLog,
  clientShowsReadinessSignal,
  detectEscalation,
  extractClientMemory,
  generateManagerReply,
} from '../../lib/ai/manager-brain.js'
import { logger } from './logger.js'
import * as repo from './repo.js'

/** Per-channel anti-ban caps for autopilot auto-sends (messengers only). */
const RATE_CAP_PER_HOUR = 20
const RATE_CAP_PER_DAY = 120
/** Minimum spacing between two autopilot sends on the SAME channel. */
const CHANNEL_COOLDOWN_MS = 8000

/** In-memory last-send timestamp per channel for the cooldown (best-effort). */
const lastSendByChannel = new Map<string, number>()

/**
 * Conversations with an AI-lead generation currently in flight. A messenger
 * inbound can arrive while the model is still composing the previous reply;
 * without this guard both calls pass the pre-checks and the contact receives
 * two answers. We claim the conversation up-front and release it in a finally,
 * so only one AI reply is ever generated per conversation at a time.
 */
const aiLeadInFlight = new Set<string>()

/** A session able to send a message to a contact handle. */
export interface SenderSession {
  sendMessage(
    target: string,
    body: string,
    opts?: { replyToMsgId?: number },
  ): Promise<{ providerMessageId: string | null }>
  /** Optional "typing…" presence while we wait (Telegram/WhatsApp support it). */
  sendTyping?(target: string, on: boolean): Promise<void>
}

/** Load + normalize a manager's active rules into the shared matcher shape. */
async function loadRules(managerId: string): Promise<AutopilotRule[]> {
  const rows = await repo.listEnabledAutopilotRules(managerId)
  return rows.map((r) => ({
    id: r.id,
    managerId: r.manager_id,
    name: r.name,
    enabled: r.enabled,
    sortOrder: r.sort_order,
    event: normalizeEvent(r.event),
    config: normalizeRuleConfig(r.config),
  }))
}

/** Resolve whether "now" is inside the channel's working hours (or null). */
async function resolveInsideWorkingHours(
  channelId: string,
): Promise<boolean | null> {
  try {
    const wh = await repo.getChannelWorkingHours(channelId)
    if (!wh || typeof wh !== 'object') return null
    const cfg = wh as WorkingHoursLike
    // A disabled working-hours config means "always live" — there's no window to
    // be inside/outside of, so the WH condition is indeterminate (null).
    if (!cfg.enabled) return null
    // isOffHoursFor returns true when OUTSIDE the configured window.
    return !isOffHoursFor(cfg)
  } catch (err) {
    logger.warn({ err, channelId }, 'autopilot: working-hours resolve failed')
    return null
  }
}

/** True if sending now would exceed this channel's anti-ban rate caps. */
async function withinRateCaps(channelId: string): Promise<boolean> {
  const last = lastSendByChannel.get(channelId) ?? 0
  if (Date.now() - last < CHANNEL_COOLDOWN_MS) return false
  const [hour, day] = await Promise.all([
    repo.countAutopilotSends(channelId, 60),
    repo.countAutopilotSends(channelId, 60 * 24),
  ])
  if (hour >= RATE_CAP_PER_HOUR) {
    logger.info({ channelId, hour }, 'autopilot: hourly cap reached, skipping')
    return false
  }
  if (day >= RATE_CAP_PER_DAY) {
    logger.info({ channelId, day }, 'autopilot: daily cap reached, skipping')
    return false
  }
  return true
}

/**
 * Send one autopilot reply with anti-ban pacing. Claims the dedupe fire BEFORE
 * sending (so concurrent inbounds can't double-fire) and rolls it back if the
 * send fails. Records the outbound with is_autopilot=true so it counts toward
 * rate caps and the panel shows it.
 */
async function fireRule(params: {
  rule: AutopilotRule
  session: SenderSession
  channelId: string
  managerId: string
  channelType: 'telegram' | 'whatsapp'
  conversationId: string
  contactHandle: string
}): Promise<boolean> {
  const { rule, session, channelId, managerId, channelType, conversationId, contactHandle } =
    params
  const replyText = rule.config.replyText.trim()
  if (!replyText) return false

  // Dedupe: claim the (rule, conversation) fire up-front when the rule is
  // once-per-conversation / first_message / no_response.
  let claimed = false
  if (ruleRequiresDedupe(rule)) {
    claimed = await repo.tryRecordAutopilotFire(rule.id, conversationId)
    if (!claimed) return false // already fired on this conversation
  }

  try {
    if (!(await withinRateCaps(channelId))) {
      if (claimed) await repo.clearAutopilotFire(rule.id, conversationId)
      return false
    }

    // Human-like pacing: show typing, wait, then send.
    const delayMs = computeSendDelayMs(rule.config, replyText)
    if (session.sendTyping) {
      await session.sendTyping(contactHandle, true).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, delayMs))
    if (session.sendTyping) {
      await session.sendTyping(contactHandle, false).catch(() => {})
    }

    const { providerMessageId } = await session.sendMessage(contactHandle, replyText)
    lastSendByChannel.set(channelId, Date.now())

    // Mirror the auto-reply into the inbox as an outbound, flagged is_autopilot.
    await repo.ingestInbound({
      channelId,
      managerId,
      channelType,
      contactName: contactHandle,
      contactHandle,
      body: replyText,
      direction: 'out',
      author: 'Автопилот',
      providerMessageId,
      isAutopilot: true,
    })
    logger.info(
      { channelId, conversationId, rule: rule.name },
      'autopilot: auto-reply sent',
    )
    return true
  } catch (err) {
    // Roll the dedupe claim back so a transient failure doesn't permanently
    // suppress the rule on this conversation.
    if (claimed) await repo.clearAutopilotFire(rule.id, conversationId).catch(() => {})
    logger.error({ err, channelId, conversationId }, 'autopilot: send failed')
    return false
  }
}

/**
 * AI-lead handler: when the AI is set to lead THIS conversation (per-thread
 * toggle) and the global assistant is enabled, generate a full contextual reply
 * with the shared "brain" and send it with the same anti-ban pacing/caps as
 * canned rules. Returns true when it handled the inbound (so the caller skips
 * canned rules and avoids double-answering). Self-guarding: never throws.
 */
async function fireAiLead(params: {
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
  if (aiLeadInFlight.has(conversationId)) return true

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

    aiLeadInFlight.add(conversationId)

    void repo.logAi({
      level: 'debug',
      source: 'ai-lead',
      event: 'inbound',
      message: 'Новое сообщение клиента в мессенджере — готовлю ответ.',
      conversationId,
      channelType,
    })

    const [lessons, corrections, history, memory] = await Promise.all([
      repo.listAiLessons(12),
      repo.listManualCorrectionRules(60),
      repo.getConversationHistoryForAi(conversationId, 16),
      repo.getConversationAiMemory(conversationId),
    ])

    // RAG: retrieve facts relevant to the client's latest message. Derived from
    // history so it works regardless of how the inbound text was passed in.
    const lastClientMsg =
      [...history].reverse().find((m) => m.role === 'client')?.body ?? ''
    const knowledge = lastClientMsg
      ? await repo.retrieveKnowledge(lastClientMsg, 4)
      : ''

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
        directives: [...exp.extraDirectives, ...config.directives],
        lessons,
        corrections,
        memory: memory.summary,
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

    // Human-like pacing: typing presence, a length-scaled delay, then send.
    const delayMs = Math.min(
      45_000,
      3000 + reply.length * 60 + Math.floor(Math.random() * 4000),
    )
    if (session.sendTyping) {
      await session.sendTyping(contactHandle, true).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, delayMs))
    if (session.sendTyping) {
      await session.sendTyping(contactHandle, false).catch(() => {})
    }

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
    lastSendByChannel.set(channelId, Date.now())

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
          memory.summary,
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

/**
 * Inbound entry point — call after a messenger inbound is persisted.
 * Self-guarding: never throws.
 */
export async function onInbound(params: {
  session: SenderSession
  channelId: string
  managerId: string
  channelType: 'telegram' | 'whatsapp'
  conversationId: string
  contactHandle: string
  text: string
  isFirstInbound: boolean
}): Promise<void> {
  try {
    // AI-lead takes priority: if the AI is driving this conversation, let it
    // answer and skip the canned-rule engine entirely (no double replies).
    const handledByAi = await fireAiLead({
      session: params.session,
      channelId: params.channelId,
      managerId: params.managerId,
      channelType: params.channelType,
      conversationId: params.conversationId,
      contactHandle: params.contactHandle,
    })
    if (handledByAi) return

    if (!(await repo.autopilotEnabled(params.managerId))) return
    const rules = await loadRules(params.managerId)
    if (rules.length === 0) return

    const input: MatchInput = {
      mode: 'inbound',
      text: params.text,
      channelId: params.channelId,
      isFirstMessage: params.isFirstInbound,
      insideWorkingHours: await resolveInsideWorkingHours(params.channelId),
    }
    const rule = selectRule(rules, input)
    if (!rule) return

    await fireRule({
      rule,
      session: params.session,
      channelId: params.channelId,
      managerId: params.managerId,
      channelType: params.channelType,
      conversationId: params.conversationId,
      contactHandle: params.contactHandle,
    })
  } catch (err) {
    logger.error({ err }, 'autopilot.onInbound failed (ignored)')
  }
}

/**
 * No-response scheduler tick — finds conversations a human hasn't answered and
 * fires any matching 'no_response' rule. `getSession` resolves the live session
 * for a channel so we can actually send. Self-guarding per conversation.
 */
export async function runNoResponseSweep(
  getSession: (channelId: string) => SenderSession | undefined,
): Promise<void> {
  try {
    // Look back at most 24h; per-rule minute thresholds are checked below.
    const candidates = await repo.findNoResponseConversations(60 * 24)
    if (candidates.length === 0) return

    // Cache rules + working-hours per manager/channel across the sweep.
    const rulesCache = new Map<string, AutopilotRule[]>()
    const whCache = new Map<string, boolean | null>()

    for (const c of candidates) {
      if (c.channelType === 'livechat') continue // handled in the Next runtime
      try {
        let rules = rulesCache.get(c.managerId)
        if (!rules) {
          if (!(await repo.autopilotEnabled(c.managerId))) {
            rulesCache.set(c.managerId, [])
            continue
          }
          rules = await loadRules(c.managerId)
          rulesCache.set(c.managerId, rules)
        }
        if (rules.length === 0) continue

        let inside = whCache.get(c.channelId)
        if (inside === undefined) {
          inside = await resolveInsideWorkingHours(c.channelId)
          whCache.set(c.channelId, inside)
        }

        // Among no_response rules, only those whose threshold has elapsed.
        const eligible = rules.filter(
          (r) =>
            r.event === 'no_response' &&
            c.minutesSilent >= r.config.noResponseMinutes,
        )
        if (eligible.length === 0) continue

        const input: MatchInput = {
          mode: 'no_response',
          text: c.lastInboundText,
          channelId: c.channelId,
          isFirstMessage: false,
          insideWorkingHours: inside,
        }
        const rule = selectRule(eligible, input)
        if (!rule) continue

        const session = getSession(c.channelId)
        if (!session) continue // channel offline → try again next tick

        await fireRule({
          rule,
          session,
          channelId: c.channelId,
          managerId: c.managerId,
          channelType: c.channelType,
          conversationId: c.conversationId,
          contactHandle: c.contactHandle,
        })
      } catch (err) {
        logger.warn({ err, conv: c.conversationId }, 'autopilot: no-response item failed')
      }
    }
  } catch (err) {
    logger.error({ err }, 'autopilot.runNoResponseSweep failed (ignored)')
  }
}
