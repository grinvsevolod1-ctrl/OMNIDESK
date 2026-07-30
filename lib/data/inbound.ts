/**
 * Generic inbound-webhook ingest shared by the MAX / VK / WhatsApp channels:
 * de-dupes provider messages, round-robin assigns a manager, upserts the
 * conversation and appends the message.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { withTransaction, type DbExecutor } from '../db'
import type { ChannelType, MediaType, Message } from '../types'
import {
  MESSAGE_REPLY_JOIN,
  MESSAGE_SELECT,
  assignManagerRoundRobin,
  toMessage,
  type MessageRow,
} from './shared'
// Cross-domain call resolved at runtime via the facade to avoid an import cycle.
import { applyLunchSubstitution } from '../data'

export async function recordWebhookInbound(input: {
  channelType: ChannelType
  channelId: string
  pool: string[]
  fallbackManagerId: string
  contactName: string
  /** Sender handle (MAX user_id or WhatsApp wa_id) — used to address replies. */
  contactHandle: string
  body: string
  /** Provider message id for de-dupe / read receipts. */
  providerMessageId?: string | null
  /** Optional media descriptor (e.g. an inbound WhatsApp photo/voice/document). */
  mediaType?: MediaType | null
  mediaMime?: string | null
  mediaName?: string | null
  /**
   * Small JSON descriptor letting the media proxy re-download the bytes on
   * demand (for WhatsApp: `{ waMediaId }`). Nothing binary is stored.
   */
  mediaRef?: Record<string, unknown> | null
  /**
   * Provider id of the message this one quotes (WhatsApp `context.id`). Resolved
   * to a local row and stored as reply_to_message_id when found.
   */
  replyToProviderId?: string | null
  /**
   * Conversation-list preview text. Defaults to `body`; pass a label like
   * "[Фото]" for media so the inbox list isn't blank when there's no caption.
   */
  preview?: string
}): Promise<{
  conversationId: string
  managerId: string
  message: Message | null
}> {
  // Round-robin assignment + lunch substitution read from the DB but don't need
  // to be inside the ingest transaction (they're advisory reads). Resolve the
  // manager for a potential NEW conversation up front, before opening the txn,
  // so the critical section stays short.
  const preview = input.preview ?? input.body

  // The whole dedupe → conversation upsert → message insert runs in ONE
  // transaction, guarded by a transaction-scoped advisory lock keyed on
  // (channelId, providerMessageId). Provider webhooks retry (VK/MAX) and our own
  // dead-letter replay can fire concurrently, so without this two deliveries of
  // the SAME message could both pass the dedupe SELECT and insert a duplicate
  // (double-counting `unread`). The lock serialises only same-message
  // deliveries; different messages hash to different keys and never contend.
  return withTransaction(async (db) => {
    if (input.providerMessageId) {
      // hashtext() yields int4; pg_advisory_xact_lock(int4, int4) auto-releases
      // at COMMIT/ROLLBACK. Scoped per (channel, provider message id).
      await db.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [input.channelId, input.providerMessageId],
      )

      // De-dupe: if we've already stored this provider message id, bail early.
      const dup = await db.query<{ id: string; conversation_id: string }>(
        `SELECT m.id, m.conversation_id
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.channel_id = $1 AND m.provider_message_id = $2
          LIMIT 1`,
        [input.channelId, input.providerMessageId],
      )
      if (dup[0]) {
        const conv = await db.query<{ manager_id: string }>(
          `SELECT manager_id FROM conversations WHERE id = $1`,
          [dup[0].conversation_id],
        )
        return {
          conversationId: dup[0].conversation_id,
          managerId: conv[0]?.manager_id ?? input.fallbackManagerId,
          message: null,
        }
      }
    }

    const existing = await db.query<{ id: string; manager_id: string }>(
      `SELECT id, manager_id FROM conversations
         WHERE channel_id = $1 AND contact_handle = $2
         ORDER BY last_message_at DESC LIMIT 1`,
      [input.channelId, input.contactHandle],
    )

    let conversationId: string
    let managerId: string
    if (existing[0]) {
      conversationId = existing[0].id
      managerId = existing[0].manager_id
      await db.query(
        `UPDATE conversations
           SET last_message = $2,
               last_message_at = now(),
               unread = unread + 1,
               contact_name = $3
         WHERE id = $1`,
        [conversationId, preview, input.contactName],
      )
    } else {
      managerId = await assignManagerRoundRobin(
        input.channelId,
        input.pool,
        input.fallbackManagerId,
      )
      // Route NEW contacts away from a manager who is on lunch to an available
      // substitute. Existing conversations keep their assigned manager above.
      managerId = (await applyLunchSubstitution(managerId)) ?? managerId
      const created = await db.query<{ id: string }>(
        `INSERT INTO conversations
           (channel_id, manager_id, channel_type, contact_name, contact_handle, last_message, last_message_at, unread)
         VALUES ($1, $2, $3, $4, $5, $6, now(), 1)
         RETURNING id`,
        [
          input.channelId,
          managerId,
          input.channelType,
          input.contactName,
          input.contactHandle,
          preview,
        ],
      )
      conversationId = created[0].id
    }

    // Resolve a quoted-reply link from the provider id of the quoted message.
    let replyToMessageId: string | null = null
    if (input.replyToProviderId) {
      const rt = await db.query<{ id: string }>(
        `SELECT m.id FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.channel_id = $1 AND m.provider_message_id = $2
          LIMIT 1`,
        [input.channelId, input.replyToProviderId],
      )
      replyToMessageId = rt[0]?.id ?? null
    }

    const msg = await db.query<{ id: string; created_at: string | Date }>(
      `INSERT INTO messages
         (conversation_id, direction, body, author, provider_message_id,
          media_type, media_mime, media_name, media_ref, reply_to_message_id)
       VALUES ($1, 'in', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at`,
      [
        conversationId,
        input.body,
        input.contactName,
        input.providerMessageId ?? null,
        input.mediaType ?? null,
        input.mediaMime ?? null,
        input.mediaName ?? null,
        input.mediaRef ? JSON.stringify(input.mediaRef) : null,
        replyToMessageId,
      ],
    )

    // Re-read through the standard select so the returned message carries media
    // url + hydrated reply preview (used by the autopilot / realtime echo).
    const full = await db.query<MessageRow>(
      `SELECT ${MESSAGE_SELECT} FROM messages m ${MESSAGE_REPLY_JOIN} WHERE m.id = $1`,
      [msg[0].id],
    )

    return {
      conversationId,
      managerId,
      message: full[0] ? toMessage(full[0]) : null,
    }
  })
}
