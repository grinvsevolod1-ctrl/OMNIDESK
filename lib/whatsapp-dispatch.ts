import 'server-only'
import {
  getLastInboundProviderId,
  getWhatsappCloudDispatchByConversationId,
  isConversationSimulated,
  markMessageFailed,
  setMessageProviderId,
} from './data'
import { markRead, sendText } from './whatsapp-cloud'

/**
 * Deliver an already-persisted outbound message to WhatsApp via the Cloud API.
 *
 * Like the MAX dispatcher, WhatsApp Cloud needs no worker/job queue: the reply
 * row is inserted optimistically by addMessage/sendMessageAction, then this
 * pushes it to the contact via POST /{phone-id}/messages and backfills the
 * provider message id (or flags the row 'failed' if Meta rejects it — e.g. the
 * 24h customer-service window has closed). Self-guarding so a delivery failure
 * can never throw into the caller.
 *
 * Returns `true` when the conversation was a Cloud API WhatsApp channel (i.e.
 * this handled delivery), and `false` when it isn't a configured Cloud channel
 * (token missing/broken). Baileys is gone, so callers must treat `false` as a
 * hard failure and surface it — never leave the message stuck "sending".
 */
export async function deliverWhatsappMessage(
  conversationId: string,
  messageId: string,
  body: string,
): Promise<boolean> {
  try {
    // Never push a simulator dialog's reply to the real WhatsApp provider.
    // Return true ("handled") so the caller doesn't treat it as a stuck/failed
    // send — the message simply stays in our DB, unsent to any real contact.
    if (await isConversationSimulated(conversationId)) return true
    const dispatch =
      await getWhatsappCloudDispatchByConversationId(conversationId)
    if (!dispatch) return false // not a Cloud API WhatsApp conversation

    const res = await sendText(
      dispatch.phoneNumberId,
      dispatch.token,
      dispatch.contactHandle,
      body,
      dispatch.proxy,
    )
    if (!res.ok) {
      console.error('[v0] deliverWhatsappMessage: send failed:', res.error)
      await markMessageFailed(messageId, res.error).catch(() => {})
      return true
    }
    const mid = res.data.messages?.[0]?.id
    if (mid) {
      await setMessageProviderId(messageId, mid).catch(() => {})
    }
    return true
  } catch (err) {
    console.error('[v0] deliverWhatsappMessage: unexpected error:', err)
    await markMessageFailed(
      messageId,
      err instanceof Error ? err.message : 'Ошибка отправки в WhatsApp.',
    ).catch(() => {})
    return true
  }
}

/**
 * Send a WhatsApp read receipt for the latest inbound message in a conversation.
 * Best-effort; no-ops for non-Cloud conversations or when nothing inbound has a
 * provider id yet.
 */
export async function markWhatsappConversationRead(
  conversationId: string,
): Promise<boolean> {
  try {
    if (await isConversationSimulated(conversationId)) return false
    const dispatch =
      await getWhatsappCloudDispatchByConversationId(conversationId)
    if (!dispatch) return false

    const providerId = await getLastInboundProviderId(conversationId)
    // Still a Cloud conversation even if there's no inbound id to ack yet.
    if (!providerId) return true

    await markRead(
      dispatch.phoneNumberId,
      dispatch.token,
      providerId,
      dispatch.proxy,
    )
    return true
  } catch (err) {
    console.error('[v0] markWhatsappConversationRead: unexpected error:', err)
    return true
  }
}
