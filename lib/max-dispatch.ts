import 'server-only'
import {
  getMaxDispatchByConversationId,
  markMessageFailed,
  setMessageProviderId,
} from './data'
import { sendMessage } from './max'

/**
 * Deliver an already-persisted outbound message to MAX.
 *
 * MAX has no worker/job queue (unlike Telegram/WhatsApp): the reply row is
 * inserted optimistically by addMessage, then this pushes it to the MAX user
 * via POST /messages and backfills the provider message id (or flags the row
 * 'failed' if MAX rejects it). Best-effort and fully self-guarding so a delivery
 * failure can never throw into the caller (send action / autopilot).
 *
 * No-ops for non-MAX conversations, so callers can invoke it unconditionally.
 */
export async function deliverMaxMessage(
  conversationId: string,
  messageId: string,
  body: string,
): Promise<void> {
  try {
    const dispatch = await getMaxDispatchByConversationId(conversationId)
    if (!dispatch) return // not a MAX conversation

    const res = await sendMessage(
      dispatch.channel.token,
      dispatch.contactHandle,
      body,
    )
    if (!res.ok) {
      console.error('[v0] deliverMaxMessage: MAX send failed:', res.error)
      await markMessageFailed(messageId).catch(() => {})
      return
    }
    if (res.data.mid) {
      await setMessageProviderId(messageId, res.data.mid).catch(() => {})
    }
  } catch (err) {
    console.error('[v0] deliverMaxMessage: unexpected error:', err)
    await markMessageFailed(messageId).catch(() => {})
  }
}
