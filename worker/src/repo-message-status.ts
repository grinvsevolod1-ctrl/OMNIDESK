/**
 * Outbound delivery statuses, provider-id backfill, read/deleted marks and
 * post-reconnect recovery queries. Split out of repo-messages.ts (which keeps
 * ingest + dialog upsert); consumers keep importing everything via `repo.*`
 * thanks to the re-export in repo.ts.
 */
import { query, one } from './db.js'

/** Outbound delivery lifecycle, ordered. Status only ever moves forward. */
export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed'

/**
 * Backfill the provider/Telegram message id onto an existing message row (the
 * panel's optimistically-inserted outbound message). Lets the panel later
 * delete / forward / react to a message we sent.
 */
export async function setMessageProviderId(
  messageId: string,
  providerMessageId: string,
): Promise<void> {
  await query(
    `UPDATE messages SET provider_message_id = $2
       WHERE id = $1 AND provider_message_id IS NULL`,
    [messageId, providerMessageId],
  )
}

/**
 * Outbound messages that never reached Telegram because the session was down
 * when the manager hit "send" — the post-reconnect delivery-recovery sweep
 * resends exactly these. A message qualifies when:
 *
 *  - it has NO provider_message_id (a confirmed send always backfills one), AND
 *  - it either failed with the stable OFFLINE marker, or still sits in the
 *    optimistic 'sent' state 2+ minutes later (its job was lost before it ran);
 *  - it is plain text (media resends could duplicate large uploads), recent
 *    (24h window — a stale resend would confuse the contact), and has NO
 *    still-queued/running send job (the queue drain will deliver those itself,
 *    so touching them here would double-send).
 */
export async function listRecoverableOutbound(
  channelId: string,
  offlineReason: string,
): Promise<Array<{ id: string; body: string; contactHandle: string }>> {
  const rows = await query<{
    id: string
    body: string
    contact_handle: string
  }>(
    `SELECT m.id, m.body, c.contact_handle
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1
        AND m.direction = 'out'
        AND m.provider_message_id IS NULL
        AND m.deleted_at IS NULL
        AND m.media_type IS NULL
        AND m.body <> ''
        AND m.created_at > now() - interval '24 hours'
        AND m.created_at < now() - interval '2 minutes'
        AND (
          (m.status = 'failed' AND m.error_reason = $2)
          OR m.status = 'sent'
        )
        AND NOT EXISTS (
          SELECT 1 FROM channel_jobs j
           WHERE j.channel_id = c.channel_id
             AND j.action = 'send_message'
             -- queued/running: the drain will deliver it; done: it WAS
             -- delivered (even if the provider-id backfill failed), so a
             -- resend here would duplicate the message for the contact.
             AND j.status IN ('queued', 'running', 'done')
             AND j.payload->>'messageId' = m.id::text
        )
      ORDER BY m.created_at ASC
      LIMIT 30`,
    [channelId, offlineReason],
  )
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    contactHandle: r.contact_handle,
  }))
}

/**
 * Advance the delivery status of a single OUTBOUND message identified by its
 * provider id within a channel. The status only moves forward (sent ->
 * delivered -> read); 'failed' may always be set. A no-op when the message is
 * unknown or already at/ahead of the target status, so duplicate provider
 * receipts are harmless.
 */
export async function setMessageStatusByProviderId(
  channelId: string,
  providerMessageId: string,
  status: MessageStatus,
  reason?: string | null,
): Promise<void> {
  // On 'failed' we also record the human-readable reason; on any forward step
  // (sent/delivered/read) we clear a stale reason so a message that ultimately
  // succeeded doesn't keep showing an old error.
  await query(
    `UPDATE messages m
        SET status = $3,
            error_reason = CASE WHEN $3 = 'failed' THEN $4 ELSE NULL END
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND c.channel_id = $1
        AND m.provider_message_id = $2
        AND m.direction = 'out'
        AND (
          $3 = 'failed'
          OR COALESCE(
               CASE m.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2
                             WHEN 'sent' THEN 1 ELSE 0 END, 0)
             < CASE $3 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2
                       WHEN 'sent' THEN 1 ELSE 0 END
        )`,
    [channelId, providerMessageId, status, reason ?? null],
  )
}

/**
 * Set the delivery status of a single message directly by its row id. Used to
 * flag a send as 'failed' when the provider rejects it, since at that point
 * there's often no provider id to match on. When `reason` is given it is stored
 * on error_reason so the panel shows WHY the send failed next to the "!" marker.
 */
export async function setMessageStatus(
  messageId: string,
  status: MessageStatus,
  reason?: string | null,
): Promise<void> {
  await query(
    `UPDATE messages
        SET status = $2,
            error_reason = CASE WHEN $2 = 'failed' THEN $3 ELSE NULL END
       WHERE id = $1 AND direction = 'out'`,
    [messageId, status, reason ?? null],
  )
}

/**
 * Mark every outbound message in a conversation as 'read' up to (and including)
 * a provider message id. Used for Telegram's "read up to max_id" outbox
 * receipts, where a single update acknowledges a whole run of our messages.
 * Only numeric provider ids (Telegram message ids) participate in the compare.
 */
export async function markOutboundReadUpTo(
  channelId: string,
  contactHandle: string,
  maxProviderId: string,
): Promise<void> {
  if (!/^\d+$/.test(maxProviderId)) return
  await query(
    `UPDATE messages m
        SET status = 'read'
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND c.channel_id = $1
        AND c.contact_handle = $2
        AND m.direction = 'out'
        AND m.provider_message_id ~ '^[0-9]+$'
        AND m.provider_message_id::bigint <= $3::bigint
        AND (m.status IS NULL OR m.status <> 'read')`,
    [channelId, contactHandle, maxProviderId],
  )
}

/**
 * Mark a message as deleted by the CONTACT (the other side revoked it). We keep
 * the original body/media intact and only stamp `deleted_at` + a 'remote'
 * origin, so the panel shows the original content with a "deleted by contact"
 * marker instead of losing it. Matched by provider message id within the
 * channel. Idempotent (only stamps a not-yet-deleted row), so duplicate
 * delete notifications are harmless. Returns the affected message ids.
 */
export async function markInboundDeletedByProviderId(
  channelId: string,
  providerMessageId: string,
): Promise<string[]> {
  return markInboundDeletedByProviderIds(channelId, [providerMessageId])
}

/**
 * Batch variant: Telegram delete updates carry an ARRAY of message ids (a
 * "clear chat" can revoke hundreds at once). One UPDATE with ANY($2) instead
 * of a query per id.
 */
export async function markInboundDeletedByProviderIds(
  channelId: string,
  providerMessageIds: string[],
): Promise<string[]> {
  if (providerMessageIds.length === 0) return []
  const rows = await query<{ id: string }>(
    `UPDATE messages m
        SET deleted_at = now(), deleted_origin = 'remote'
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND c.channel_id = $1
        AND m.provider_message_id = ANY($2)
        AND m.deleted_at IS NULL
      RETURNING m.id`,
    [channelId, providerMessageIds],
  )
  return rows.map((r) => r.id)
}

/**
 * Recent inbound provider message ids for a conversation, newest first. Used to
 * build WhatsApp read-receipt keys when the operator opens a chat so the
 * contact sees our blue ticks. Bounded so we never replay an entire thread.
 */
export async function getRecentInboundProviderIds(
  channelId: string,
  contactHandle: string,
  limit = 30,
): Promise<string[]> {
  const rows = await query<{ provider_message_id: string }>(
    `SELECT m.provider_message_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1
        AND c.contact_handle = $2
        AND m.direction = 'in'
        AND m.provider_message_id IS NOT NULL
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [channelId, contactHandle, limit],
  )
  return rows.map((r) => r.provider_message_id)
}

/** Fetch the outbound target (contact_handle) for a conversation. */
export async function getOutboundTarget(
  conversationId: string,
): Promise<{ contactHandle: string; channelId: string } | null> {
  const row = await one<{ contact_handle: string; channel_id: string }>(
    'SELECT contact_handle, channel_id FROM conversations WHERE id = $1',
    [conversationId],
  )
  if (!row) return null
  return { contactHandle: row.contact_handle, channelId: row.channel_id }
}
