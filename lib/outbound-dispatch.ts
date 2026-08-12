import 'server-only'
import { query } from './db'
import { deliverMaxMessage } from './max-dispatch'
import { deliverVkMessage } from './vk-dispatch'
import { deliverWhatsappMessage } from './whatsapp-dispatch'

/**
 * Route an already-persisted outbound message to its provider by channel type.
 *
 * Replaces the old "call every dispatcher unconditionally and let each no-op"
 * pattern: one cheap channel-type lookup instead of N per-dispatcher DB probes.
 *
 *   • MAX / VK / WhatsApp → direct Bot/Cloud API dispatcher.
 *   • Live chat → no delivery needed: the inserted 'out' row already fires a
 *     realtime NOTIFY that the website widget receives over SSE.
 *   • Telegram → NOT handled here (goes through the worker job queue; callers
 *     that can reach Telegram enqueue a job themselves, see deliverNudge /
 *     sendMessageAction).
 *
 * Best-effort and self-guarding: a routing/delivery failure never throws into
 * the caller (each dispatcher flags the row 'failed' on provider errors).
 */
export async function deliverOutboundByChannel(
  conversationId: string,
  messageId: string,
  body: string,
): Promise<void> {
  try {
    const rows = await query<{ type: string }>(
      `SELECT ch.type
         FROM conversations c
         JOIN channels ch ON ch.id = c.channel_id
        WHERE c.id = $1`,
      [conversationId],
    )
    const channelType = rows[0]?.type ?? null

    switch (channelType) {
      case 'max':
        await deliverMaxMessage(conversationId, messageId, body)
        break
      case 'vk':
        await deliverVkMessage(conversationId, messageId, body)
        break
      case 'whatsapp':
        await deliverWhatsappMessage(conversationId, messageId, body)
        break
      default:
        // livechat (SSE via NOTIFY) or unknown — nothing to push.
        break
    }
  } catch (err) {
    console.error('deliverOutboundByChannel: routing failed:', err)
  }
}
