/**
 * Inbound/outbound message persistence: ingest, dialog upsert, provider ids,
 * delivery statuses, read/deleted marks and recovery helpers. Split out of
 * repo.ts following the repo-media/repo-ai pattern; consumers keep importing
 * everything via `repo.*` thanks to the re-export in repo.ts.
 */
import { query, one } from './db.js'

/** Outbound delivery lifecycle, ordered. Status only ever moves forward. */
export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed'

/* --------------------- Inbound messages persistence ------------------ */

/** Outcome of an ingestInbound call, used by Autopilot to decide whether to fire. */
export interface IngestResult {
  /** Conversation the message belongs to (created or existing). */
  conversationId: string
  /**
   * Id of the message row for this ingest — the freshly inserted row, or the
   * existing row when this was a dedup replay. Null only if it couldn't be
   * resolved. Lets the caller attach stored media bytes to the exact message.
   */
  messageId: string | null
  /** True only when a NEW message row was actually written (false on a dedup). */
  wrote: boolean
  /**
   * True when this is the FIRST inbound message of a brand-new conversation —
   * i.e. the conversation was just created by this inbound. Drives the
   * "first_message" autopilot trigger.
   */
  isFirstInbound: boolean
}

/**
 * Decide who should HANDLE a new conversation, accounting for lunch breaks.
 * If the channel owner is active and available, they keep it. Otherwise route
 * to an available substitute (active, not on lunch) via the shared atomic
 * round-robin counter, mirroring the app-side applyLunchSubstitution so both
 * ingest paths behave identically. Falls back to the owner when nobody is free,
 * so we never drop a message or violate the conversations FK.
 */
async function resolveLunchManager(ownerId: string): Promise<string> {
  try {
    // Owner available? (exists, active, not on lunch)
    const owner = await one<{ id: string }>(
      `SELECT id FROM managers
        WHERE id = $1 AND status = 'active' AND on_lunch = false
        LIMIT 1`,
      [ownerId],
    )
    if (owner) return ownerId

    // Owner away — gather available substitutes, deterministically ordered.
    const subs = await query<{ id: string }>(
      `SELECT id FROM managers
        WHERE status = 'active' AND on_lunch = false AND id <> $1::uuid
        ORDER BY id ASC`,
      [ownerId],
    )
    if (subs.length === 0) return ownerId
    if (subs.length === 1) return subs[0].id

    // Atomic, shared round-robin cursor (same counter the app side uses).
    const rows = await query<{ n: string | number }>(
      `INSERT INTO offhours_counters (name, n)
         VALUES ('lunch_substitute', 1)
       ON CONFLICT (name)
         DO UPDATE SET n = offhours_counters.n + 1
       RETURNING n`,
    )
    const n = Number(rows[0]?.n ?? 1)
    return subs[(n - 1) % subs.length].id
  } catch (err) {
    // If migration 034 (on_lunch) isn't applied yet, never break ingestion —
    // just keep the channel owner as the handler.
    console.error('[worker] resolveLunchManager failed (migration 034?):', err)
    return ownerId
  }
}

/**
 * Persist an inbound message, creating/updating its conversation. The realtime
 * NOTIFY triggers fire automatically so the panel pushes it to the browser.
 */
export async function ingestInbound(input: {
  channelId: string
  managerId: string
  channelType: 'telegram' | 'whatsapp' | 'livechat'
  contactName: string
  contactHandle: string
  /**
   * Public @username of the contact (without the leading '@'), when they have
   * one. Stored separately from the addressing handle so the panel can show it
   * next to the display name. Omit/null when unknown.
   */
  contactUsername?: string | null
  body: string
  /**
   * Message direction. Defaults to 'in' (a message FROM the contact). Pass
   * 'out' for messages the operator sent from their own linked device (e.g.
   * WhatsApp `fromMe`) so the panel mirrors both sides of the conversation.
   * Outbound messages never bump the unread counter.
   */
  direction?: 'in' | 'out'
  /**
   * Display name for the message author. Defaults to contactName for inbound
   * and 'You' for outbound, so operator-sent messages aren't labelled with the
   * contact's name.
   */
  author?: string
  /**
   * Stable provider-side message id (e.g. WhatsApp m.key.id). When present the
   * insert is de-duplicated, so the same message arriving live AND via history
   * replay (or after a relink) is stored only once.
   */
  providerMessageId?: string | null
  /**
   * Real message timestamp. Defaults to now(). History-imported messages MUST
   * pass their original time so the thread keeps chronological order.
   */
  createdAt?: Date
  /**
   * Whether this message should bump the unread badge. Defaults to true for
   * inbound. History import passes false so backfilling old chats doesn't light
   * up every conversation as unread.
   */
  countUnread?: boolean
  /**
   * Optional media descriptor. When the message carries media we record its
   * kind (sticker/voice/video_note/…), MIME, file name and a small JSON `ref`
   * that lets the worker re-download the bytes on demand. No binary is stored.
   */
  mediaType?: string | null
  mediaMime?: string | null
  mediaName?: string | null
  mediaRef?: unknown
  /** True when this outbound was generated by Autopilot (for rate caps/badging). */
  isAutopilot?: boolean
}): Promise<IngestResult> {
  const direction = input.direction ?? 'in'
  // Normalise the username: strip a leading '@' and blank → null, so storage is
  // consistent regardless of how the caller passes it.
  const contactUsername = input.contactUsername?.replace(/^@/, '').trim() || null
  const createdAt = input.createdAt ?? new Date()
  const countUnread = input.countUnread ?? direction === 'in'
  const author = input.author ?? (direction === 'out' ? 'You' : input.contactName)
  const providerId = input.providerMessageId ?? null
  const mediaType = input.mediaType ?? null
  const mediaMime = input.mediaMime ?? null
  const mediaName = input.mediaName ?? null
  const mediaRef =
    input.mediaRef === undefined || input.mediaRef === null
      ? null
      : JSON.stringify(input.mediaRef)

  // find existing open conversation for this contact on this channel
  const existing = await one<{ id: string }>(
    `SELECT id FROM conversations
     WHERE channel_id = $1 AND contact_handle = $2
     ORDER BY last_message_at DESC LIMIT 1`,
    [input.channelId, input.contactHandle],
  )

  let conversationId: string
  let conversationExisted: boolean
  if (existing) {
    conversationId = existing.id
    conversationExisted = true
  } else {
    // Route a NEW conversation away from a manager who is on lunch to an
    // available substitute (round-robin). Existing conversations are reused
    // above and keep their assigned manager, so this only affects new ones.
    const handlerId = await resolveLunchManager(input.managerId)
    const created = await one<{ id: string }>(
      `INSERT INTO conversations
         (channel_id, manager_id, channel_type, contact_name, contact_handle, contact_username, last_message, last_message_at, unread)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.channelId,
        handlerId,
        input.channelType,
        input.contactName,
        input.contactHandle,
        contactUsername,
        input.body,
        createdAt,
        countUnread ? 1 : 0,
      ],
    )
    conversationId = created!.id
    conversationExisted = false
  }

  // Insert the message, de-duplicating on the stable provider id when present.
  // RETURNING tells us whether a row was actually written: on a duplicate the
  // ON CONFLICT path returns nothing, so we must NOT touch the conversation
  // preview/unread again (otherwise replays would inflate the counters).
  const inserted = await one<{ id: string }>(
    `INSERT INTO messages
       (conversation_id, direction, body, author, created_at, provider_message_id,
        media_type, media_mime, media_name, media_ref, is_autopilot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (conversation_id, provider_message_id)
       WHERE provider_message_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      conversationId,
      direction,
      input.body,
      author,
      createdAt,
      providerId,
      mediaType,
      mediaMime,
      mediaName,
      mediaRef,
      input.isAutopilot ?? false,
    ],
  )

  // Duplicate of an already-stored message on an existing conversation: stop
  // updating counters, but still resolve the existing message id so the caller
  // can back-fill stored media bytes for a row that predates media storage.
  if (!inserted && conversationExisted) {
    let existingMessageId: string | null = null
    if (providerId) {
      const row = await one<{ id: string }>(
        `SELECT id FROM messages
          WHERE conversation_id = $1 AND provider_message_id = $2
          LIMIT 1`,
        [conversationId, providerId],
      )
      existingMessageId = row?.id ?? null
    }
    return {
      conversationId,
      messageId: existingMessageId,
      wrote: false,
      isFirstInbound: false,
    }
  }

  // Refresh the conversation only for an existing thread (a freshly created one
  // was already seeded above). The preview only moves forward in time, so an
  // out-of-order history message never clobbers a newer live preview.
  if (conversationExisted) {
    await query(
      `UPDATE conversations
         SET contact_name = CASE WHEN $4 THEN $5 ELSE contact_name END,
             contact_username = COALESCE($7, contact_username),
             last_message = CASE WHEN $2 >= last_message_at THEN $3 ELSE last_message END,
             last_message_at = GREATEST(last_message_at, $2),
             unread = unread + CASE WHEN $6 THEN 1 ELSE 0 END
       WHERE id = $1`,
      [
        conversationId,
        createdAt,
        input.body,
        // Only refresh the title from inbound messages whose name isn't just the
        // raw handle (avoids overwriting a real name with a phone number).
        direction === 'in' && input.contactName !== input.contactHandle,
        input.contactName,
        countUnread,
        // Keep the last known username; only overwrite when we actually have one.
        contactUsername,
      ],
    )
  }

  // Manual human takeover from the operator's own device: a real outbound
  // (mirrored fromMe message) that we did NOT generate ourselves hands the
  // conversation back to the human, so PAUSE AI-lead for this thread (global-
  // lead opt-out). Autopilot/AI sends carry is_autopilot=true and must NOT
  // pause it. Only stamp a freshly written row (skip replays) on an existing
  // thread. The legacy flag is cleared too so old/new readers agree.
  if (
    inserted &&
    conversationExisted &&
    direction === 'out' &&
    input.isAutopilot !== true
  ) {
    await query(
      `UPDATE conversations
          SET ai_paused = true, ai_autopilot_enabled = false
        WHERE id = $1 AND ai_paused = false`,
      [conversationId],
    )
  }

  // A first inbound is one that just created the conversation with an inbound
  // message (not an operator's own fromMe echo, not a history backfill).
  return {
    conversationId,
    messageId: inserted?.id ?? null,
    wrote: !!inserted,
    isFirstInbound: !conversationExisted && direction === 'in',
  }
}

/**
 * Upsert a conversation from a synced chat/dialog (Telegram history import).
 *
 * Unlike ingestInbound this is idempotent across reconnects: it keys on
 * (channel_id, contact_handle), refreshes the preview + unread count, and only
 * seeds a single "last message" row when the conversation is first created. It
 * never keeps appending the same history message on every restart.
 */
export async function upsertDialog(input: {
  channelId: string
  managerId: string
  channelType: 'telegram' | 'whatsapp'
  contactName: string
  contactHandle: string
  /** Public @username (without leading '@'), when known. */
  contactUsername?: string | null
  lastMessage: string
  lastMessageAt: Date
  unread: number
  lastFromMe: boolean
}): Promise<void> {
  const contactUsername = input.contactUsername?.replace(/^@/, '').trim() || null
  const existing = await one<{ id: string }>(
    `SELECT id FROM conversations
       WHERE channel_id = $1 AND contact_handle = $2
       LIMIT 1`,
    [input.channelId, input.contactHandle],
  )

  if (existing) {
    await query(
      `UPDATE conversations
         SET contact_name = $2,
             contact_username = COALESCE($6, contact_username),
             last_message = $3,
             last_message_at = $4,
             unread = $5
       WHERE id = $1`,
      [
        existing.id,
        input.contactName,
        input.lastMessage,
        input.lastMessageAt,
        input.unread,
        contactUsername,
      ],
    )
    return
  }

  const created = await one<{ id: string }>(
    `INSERT INTO conversations
       (channel_id, manager_id, channel_type, contact_name, contact_handle, contact_username, last_message, last_message_at, unread)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.channelId,
      input.managerId,
      input.channelType,
      input.contactName,
      input.contactHandle,
      contactUsername,
      input.lastMessage,
      input.lastMessageAt,
      input.unread,
    ],
  )

  // Seed the thread with the last known message so opening the conversation
  // isn't blank. Direction reflects who sent that last message.
  await query(
    `INSERT INTO messages (conversation_id, direction, body, author, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      created!.id,
      input.lastFromMe ? 'out' : 'in',
      input.lastMessage,
      input.lastFromMe ? 'You' : input.contactName,
      input.lastMessageAt,
    ],
  )
}

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
