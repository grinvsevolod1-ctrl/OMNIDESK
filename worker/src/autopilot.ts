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
 * Anti-ban posture for messengers lives in autopilot-pacing.ts (humanized
 * typing delay, per-channel cooldown, hour/day rate caps); the AI-lead reply
 * path lives in autopilot-ai-lead.ts. Both are re-exported here so importers
 * keep resolving them from './autopilot.js'.
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
import { logger } from './logger.js'
import * as repo from './repo.js'
import { fireAiLead } from './autopilot-ai-lead.js'
import {
  noteAutopilotSend,
  typeWhileWaiting,
  withinRateCaps,
  type SenderSession,
} from './autopilot-pacing.js'

export type { SenderSession } from './autopilot-pacing.js'

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

    // Human-like pacing: hold "typing…" for the whole delay, then send.
    const delayMs = computeSendDelayMs(rule.config, replyText)
    await typeWhileWaiting(session, contactHandle, delayMs)

    const { providerMessageId } = await session.sendMessage(contactHandle, replyText)
    noteAutopilotSend(channelId)

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
