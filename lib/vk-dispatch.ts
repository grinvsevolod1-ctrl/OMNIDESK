import 'server-only'
import {
  getVkDispatchByConversationId,
  markMessageFailed,
  setMessageProviderId,
} from './data'
import { sendMessage } from './vk'

/**
 * Deliver an already-persisted outbound message to VK.
 *
 * VK has no worker/job queue (unlike Telegram/WhatsApp): the reply row is
 * inserted optimistically by addMessage, then this pushes it to the VK user via
 * messages.send and backfills the provider message id (or flags the row
 * 'failed' if VK rejects it). Best-effort and fully self-guarding so a delivery
 * failure can never throw into the caller (send action / autopilot).
 *
 * No-ops for non-VK conversations, so callers can invoke it unconditionally.
 */
export async function deliverVkMessage(
  conversationId: string,
  messageId: string,
  body: string,
): Promise<void> {
  try {
    const dispatch = await getVkDispatchByConversationId(conversationId)
    if (!dispatch) return // not a VK conversation

    const res = await sendMessage(
      dispatch.channel.token,
      dispatch.contactHandle,
      body,
    )
    if (!res.ok) {
      console.error('[v0] deliverVkMessage: VK send failed:', res.error)
      await markMessageFailed(messageId).catch(() => {})
      return
    }
    if (res.data.messageId) {
      await setMessageProviderId(messageId, res.data.messageId).catch(() => {})
    }
  } catch (err) {
    console.error('[v0] deliverVkMessage: unexpected error:', err)
    await markMessageFailed(messageId).catch(() => {})
  }
}
