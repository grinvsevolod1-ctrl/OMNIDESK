import 'server-only'
import {
  getVkDispatchByConversationId,
  isConversationSimulated,
  markMessageFailed,
  setMessageProviderId,
} from './data'
import { markAsRead, sendMessage, setActivity } from './vk'

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
    // Never push a simulator dialog's reply to the real VK provider.
    if (await isConversationSimulated(conversationId)) return
    const dispatch = await getVkDispatchByConversationId(conversationId)
    if (!dispatch) return // not a VK conversation

    const res = await sendMessage(
      dispatch.channel.token,
      dispatch.contactHandle,
      body,
      dispatch.proxy,
    )
    if (!res.ok) {
      console.error('[v0] deliverVkMessage: VK send failed:', res.error)
      await markMessageFailed(messageId, res.error).catch(() => {})
      return
    }
    if (res.data.messageId) {
      await setMessageProviderId(messageId, res.data.messageId).catch(() => {})
    }
  } catch (err) {
    console.error('[v0] deliverVkMessage: unexpected error:', err)
    await markMessageFailed(
      messageId,
      err instanceof Error ? err.message : 'Ошибка отправки в VK.',
    ).catch(() => {})
  }
}

/**
 * Show the "typing…" indicator to the VK user for this conversation. Routed
 * through the account's proxy. Best-effort; no-ops for non-VK conversations.
 * Returns true when it handled a VK conversation (so callers can branch).
 */
export async function setVkTyping(conversationId: string): Promise<boolean> {
  try {
    if (await isConversationSimulated(conversationId)) return false
    const dispatch = await getVkDispatchByConversationId(conversationId)
    if (!dispatch) return false
    await setActivity(
      dispatch.channel.token,
      dispatch.contactHandle,
      dispatch.proxy,
    )
    return true
  } catch (err) {
    console.error('[v0] setVkTyping: unexpected error:', err)
    return true
  }
}

/**
 * Send a VK read receipt for the conversation (marks the dialog read so the
 * user sees their messages were read). Best-effort; no-ops for non-VK
 * conversations. Returns true when it handled a VK conversation.
 */
export async function markVkConversationRead(
  conversationId: string,
): Promise<boolean> {
  try {
    if (await isConversationSimulated(conversationId)) return false
    const dispatch = await getVkDispatchByConversationId(conversationId)
    if (!dispatch) return false
    await markAsRead(
      dispatch.channel.token,
      dispatch.contactHandle,
      dispatch.proxy,
    )
    return true
  } catch (err) {
    console.error('[v0] markVkConversationRead: unexpected error:', err)
    return true
  }
}
