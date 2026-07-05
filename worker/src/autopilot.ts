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
import { logger } from './logger.js'
import * as repo from './repo.js'

/** Per-channel anti-ban caps for autopilot auto-sends (messengers only). */
const RATE_CAP_PER_HOUR = 20
const RATE_CAP_PER_DAY = 120
/** Minimum spacing between two autopilot sends on the SAME channel. */
const CHANNEL_COOLDOWN_MS = 8000

/** In-memory last-send timestamp per channel for the cooldown (best-effort). */
const lastSendByChannel = new Map<string, number>()

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
