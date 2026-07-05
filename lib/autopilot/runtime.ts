import 'server-only'
import { query } from '../db'
import { addMessage, getLivechatWorkingHoursByChannelId } from '../data'
import { deliverMaxMessage } from '../max-dispatch'
import { deliverVkMessage } from '../vk-dispatch'
import { deliverWhatsappMessage } from '../whatsapp-dispatch'
import { isOffHoursFor } from '../offhours'
import {
  getActiveAutopilot,
  tryRecordFire,
} from './data'
import {
  type AutopilotRule,
  type MatchInput,
  ruleRequiresDedupe,
  selectRule,
} from './match'

/**
 * Autopilot runtime for LIVE-CHAT inbound (runs inside the Next.js ingest
 * route). Messenger inbound (Telegram/WhatsApp) is handled separately in the
 * worker, which shares the same pure matcher (lib/autopilot/match.ts).
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

    await sendAutoReply(input.managerId, input.conversationId, replyText, rule)
  } catch (err) {
    console.error('[v0] autopilot(livechat) failed:', err)
  }
}

/** Send the auto-reply as an outbound message authored by the manager. */
async function sendAutoReply(
  managerId: string,
  conversationId: string,
  body: string,
  _rule: AutopilotRule,
): Promise<void> {
  // Author with the manager's display name so the visitor sees a normal reply.
  const nameRows = await query<{ name: string }>(
    'SELECT name FROM managers WHERE id = $1',
    [managerId],
  )
  const author = nameRows[0]?.name?.trim() || 'Поддержка'
  // addMessage inserts the outbound row; the DB notify trigger delivers it to
  // both the widget (SSE) and the manager's inbox in real time.
  const msg = await addMessage({ conversationId, managerId, body, author })
  // Webhook-based channels have no SSE widget — the reply must be pushed to the
  // provider. Both dispatchers no-op for conversations they don't own, so it's
  // safe to call them unconditionally.
  if (msg) {
    await deliverMaxMessage(conversationId, msg.id, body)
    await deliverVkMessage(conversationId, msg.id, body)
    await deliverWhatsappMessage(conversationId, msg.id, body)
  }
}
