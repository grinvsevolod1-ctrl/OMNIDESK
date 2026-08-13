/**
 * Inbound message persistence: ingest and dialog upsert. Split out of repo.ts
 * following the repo-media/repo-ai pattern. Delivery statuses, provider-id
 * backfill and recovery queries live in repo-message-status.ts (re-exported
 * below); consumers keep importing everything via `repo.*`.
 */
import { query, one } from './db.js'

export * from './repo-message-status.js'

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
    // role = 'manager' is REQUIRED: the managers table also holds curators
    // (менеджеры по кадрам) and the admin row — inbound dialogs must never be
    // routed to them. Mirrors the app-side applyLunchSubstitution filter.
    const subs = await query<{ id: string }>(
      `SELECT id FROM managers
        WHERE role = 'manager'
          AND status = 'active' AND on_lunch = false AND id <> $1::uuid
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
