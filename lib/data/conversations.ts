/**
 * Conversations & messages: listing, status/lead, mute, reactions, dispatch,
 * read state, reply reminders and conversation transfer.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { query, withTransaction } from '../db'
import type {
  ChannelType,
  Conversation,
  LeadStatus,
  MediaType,
  Message,
  MessageReaction,
  NotLiquidReason,
} from '../types'
import {
  conversationColumns,
  effectiveStatusSql,
  MESSAGE_REPLY_JOIN,
  MESSAGE_SELECT,
  toConversation,
  toMessage,
  type ConversationRow,
  type MessageRow,
} from './shared'

/* -------------------------- Conversations --------------------------- */

/**
 * Hard cap on how many conversations a single listing returns. The inbox shows
 * the most-recently-active threads first and prepends new ones live over SSE, so
 * capping the initial load bounds memory + payload for a manager who has
 * accumulated thousands of historical conversations. Older threads remain in the
 * DB and are reachable via search/analytics.
 */
const CONVERSATION_LIST_LIMIT = 500

export async function listConversations(
  managerId: string,
): Promise<Conversation[]> {
  const rows = await query<ConversationRow & { channel_name: string | null }>(
    `SELECT ${conversationColumns('c')}, ch.name AS channel_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.manager_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT $2`,
    [managerId, CONVERSATION_LIST_LIMIT],
  )
  return rows.map((r) => ({
    ...toConversation(r),
    channelName: r.channel_name ?? undefined,
  }))
}

/**
 * List a manager's conversations filtered by EFFECTIVE lead status (and, for
 * «Не ликвид», optionally a reason sub-status). Powers the dashboard status
 * board's drill-down modal. Manager-scoped — never leaks other managers' leads.
 */
export async function listConversationsByStatus(
  managerId: string,
  status: LeadStatus,
  reason?: NotLiquidReason,
): Promise<Conversation[]> {
  const params: unknown[] = [managerId, status]
  let reasonFilter = ''
  if (status === 'not_liquid' && reason) {
    params.push(reason)
    reasonFilter = ` AND c.status_detail = $3`
  }
  params.push(CONVERSATION_LIST_LIMIT)
  const limitParam = `$${params.length}`
  const rows = await query<ConversationRow & { channel_name: string | null }>(
    `SELECT ${conversationColumns('c')}, ch.name AS channel_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.manager_id = $1
        AND ${effectiveStatusSql('c')} = $2${reasonFilter}
      ORDER BY c.last_message_at DESC
      LIMIT ${limitParam}`,
    params,
  )
  return rows.map((r) => ({
    ...toConversation(r),
    channelName: r.channel_name ?? undefined,
  }))
}

export async function getConversation(
  conversationId: string,
  managerId: string,
): Promise<Conversation | null> {
  const rows = await query<ConversationRow>(
    `SELECT ${conversationColumns()} FROM conversations WHERE id = $1 AND manager_id = $2 LIMIT 1`,
    [conversationId, managerId],
  )
  return rows[0] ? toConversation(rows[0]) : null
}

/**
 * Resume/pause the AI for a single conversation (the per-thread inbox toggle).
 * Under global-lead mode (migration 056) the AI leads every thread while the
 * master switch is on, so this toggle is really "pause = opt out here":
 *
 *   enabled = true  → resume  → ai_paused = false
 *   enabled = false → pause    → ai_paused = true
 *
 * The legacy `ai_autopilot_enabled` flag is kept in sync so old readers agree.
 * Resuming also clears any pending handoff banner. Manager-scoped; returns the
 * new "AI is leading here" state, or null when the thread isn't owned.
 *
 * Turning the AI OFF is a manager takeover, so it also moves the lead to
 * «Передан человеку» ('handoff') — but only while it still has its default
 * status, so a manual «Ликвид»/«Не ликвид»/«Передан» classification is never
 * overwritten. Turning the AI back ON never touches the status.
 */
export async function setConversationAiAutopilot(
  conversationId: string,
  managerId: string,
  enabled: boolean,
): Promise<boolean | null> {
  const rows = await query<{ ai_paused: boolean }>(
    `UPDATE conversations
        SET ai_paused = $3,
            ai_autopilot_enabled = $4,
            ai_handoff_pending = CASE WHEN $4 THEN false ELSE ai_handoff_pending END,
            status = CASE
              WHEN NOT $4 AND COALESCE(status, 'unsubscribed') = 'unsubscribed'
              THEN 'handoff' ELSE status END,
            status_updated_at = CASE
              WHEN NOT $4 AND COALESCE(status, 'unsubscribed') = 'unsubscribed'
              THEN now() ELSE status_updated_at END
      WHERE id = $1 AND manager_id = $2
      RETURNING ai_paused`,
    [conversationId, managerId, !enabled, enabled],
  )
  return rows[0] ? !rows[0].ai_paused : null
}

/**
 * Mark a conversation as read on our side: zero its unread counter and return
 * what the worker needs to send read receipts to the contact (so they see our
 * blue ticks). Returns null when the manager doesn't own the conversation.
 */
export async function markConversationRead(
  conversationId: string,
  managerId: string,
): Promise<{
  channelId: string
  channelType: ChannelType
  contactHandle: string
} | null> {
  const rows = await query<{
    channel_id: string
    channel_type: ChannelType
    contact_handle: string
  }>(
    `UPDATE conversations
        SET unread = 0
      WHERE id = $1 AND manager_id = $2
      RETURNING channel_id, channel_type, contact_handle`,
    [conversationId, managerId],
  )
  if (!rows[0]) return null
  return {
    channelId: rows[0].channel_id,
    channelType: rows[0].channel_type,
    contactHandle: rows[0].contact_handle,
  }
}

/**
 * Cap on how many messages a single thread hydrates with. A very long
 * conversation would otherwise ship its entire history to the browser on every
 * inbox load (and the page eagerly hydrates several threads at once). The inbox
 * virtualizes the list and prepends new messages live over SSE, so loading the
 * most-recent slice is what a manager actually needs; older history stays in the
 * DB. Fetched newest-first with a LIMIT, then reversed back to chronological
 * (oldest-first) order for rendering.
 */
const MESSAGE_HISTORY_LIMIT = 300

export async function listMessages(
  conversationId: string,
  managerId: string,
): Promise<Message[]> {
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     ${MESSAGE_REPLY_JOIN}
     WHERE m.conversation_id = $1 AND c.manager_id = $2
     ORDER BY m.created_at DESC
     LIMIT $3`,
    [conversationId, managerId, MESSAGE_HISTORY_LIMIT],
  )
  // Re-order to chronological (oldest-first) for the transcript view.
  return rows.reverse().map(toMessage)
}

/**
 * Load an older page of a thread's history: the most recent messages created
 * strictly BEFORE `before` (an ISO timestamp — normally the oldest message the
 * client currently holds). Powers the inbox "load older messages" control for
 * threads longer than MESSAGE_HISTORY_LIMIT. Manager-scoped via the join, so an
 * id that isn't the caller's simply yields []. Returned oldest-first so the
 * caller can prepend the slice directly.
 */
export async function listMessagesBefore(
  conversationId: string,
  managerId: string,
  before: string,
  limit = MESSAGE_HISTORY_LIMIT,
): Promise<Message[]> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), MESSAGE_HISTORY_LIMIT)
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     ${MESSAGE_REPLY_JOIN}
     WHERE m.conversation_id = $1 AND c.manager_id = $2 AND m.created_at < $3
     ORDER BY m.created_at DESC
     LIMIT $4`,
    [conversationId, managerId, before, capped],
  )
  return rows.reverse().map(toMessage)
}

/**
 * Backfill: every message for a manager created strictly after `since`,
 * ordered oldest-first. Used by the SSE route to replay events a browser
 * missed while it was disconnected (gap recovery via Last-Event-ID).
 */
const GAP_RECOVERY_LIMIT = 500

export async function getMessagesSince(
  managerId: string,
  since: Date,
): Promise<{
  messages: Array<Message & { contactHandle: string; channelId: string }>
  /**
   * True when more than GAP_RECOVERY_LIMIT messages were missed. The caller
   * must NOT trust `messages` as complete in that case and should force a full
   * client resync instead of replaying a partial (lossy) set.
   */
  truncated: boolean
}> {
  const rows = await query<
    MessageRow & { channel_id: string; contact_handle: string }
  >(
    // Fetch one extra row so we can detect (rather than silently swallow) the
    // case where the client missed more than the replay limit.
    `SELECT ${MESSAGE_SELECT}, c.channel_id, c.contact_handle
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     ${MESSAGE_REPLY_JOIN}
     WHERE c.manager_id = $1 AND m.created_at > $2
     ORDER BY m.created_at ASC
     LIMIT $3`,
    [managerId, since.toISOString(), GAP_RECOVERY_LIMIT + 1],
  )
  const truncated = rows.length > GAP_RECOVERY_LIMIT
  const capped = truncated ? rows.slice(0, GAP_RECOVERY_LIMIT) : rows
  return {
    messages: capped.map((r) => ({
      ...toMessage(r),
      channelId: r.channel_id,
      contactHandle: r.contact_handle,
    })),
    truncated,
  }
}

/**
 * Persist an outbound (agent -> contact) message and mark the conversation
 * read. Returns null if the conversation doesn't belong to the manager.
 */
export async function addMessage(input: {
  conversationId: string
  managerId: string
  body: string
  author: string
  /** Optional media descriptor, e.g. an outgoing sticker or WhatsApp file. */
  mediaType?: MediaType
  mediaMime?: string
  mediaName?: string
  /**
   * Small JSON descriptor letting the media proxy re-download the bytes (for an
   * outbound WhatsApp file: `{ waMediaId }`). Nothing binary is stored.
   */
  mediaRef?: Record<string, unknown> | null
  /** Optional quoted-reply target (a message id in the same conversation). */
  replyToMessageId?: string
  /** Conversation-list preview text; defaults to `body` (use for media). */
  preview?: string
  /**
   * True when this outbound row was authored by the AI manager-assistant. AI
   * messages must NOT pause AI-lead; any other (human) outbound message does —
   * that's how a manual reply hands the conversation back to a person.
   */
  byAi?: boolean
}): Promise<Message | null> {
  // Run the insert + conversation update atomically so a crash between the two
  // can never leave a persisted message whose conversation preview / ai_paused
  // state was never updated (a visible desync of the list and AI-lead state).
  // Ownership is folded into the INSERT (INSERT ... SELECT ... WHERE manager_id)
  // so we neither insert into someone else's conversation nor pay an extra
  // round-trip for the check.
  return withTransaction(async (db) => {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO messages
         (conversation_id, direction, body, author, media_type, media_mime, media_name, media_ref, reply_to_message_id, status)
       SELECT c.id, 'out', $2, $3, $4, $5, $6, $7, $8, 'sent'
         FROM conversations c
        WHERE c.id = $1 AND c.manager_id = $9
       RETURNING id`,
      [
        input.conversationId,
        input.body,
        input.author,
        input.mediaType ?? null,
        input.mediaMime ?? null,
        input.mediaName ?? null,
        input.mediaRef ? JSON.stringify(input.mediaRef) : null,
        input.replyToMessageId ?? null,
        input.managerId,
      ],
    )
    // No row inserted => the conversation doesn't belong to this manager.
    if (rows.length === 0) return null

    // A human outbound message hands the thread back from the AI: pause AI-lead
    // for this conversation (global-lead opt-out) in the same UPDATE. AI-authored
    // rows keep it running. The legacy `ai_autopilot_enabled` flag is cleared too
    // so both old and new readers agree.
    //
    // A manager stepping in also moves the lead to «Передан человеку» ('handoff')
    // — but ONLY while it still has its default status, so a manual «Ликвид» /
    // «Не ликвид» / «Передан» classification is never clobbered. AI-authored rows
    // never touch the status. This mirrors the AI's own handoff and keeps the
    // «Ликвид» decision manager-only.
    const humanTakeover = !input.byAi
      ? `, ai_paused = true, ai_autopilot_enabled = false,
         status = CASE WHEN COALESCE(status, 'unsubscribed') = 'unsubscribed'
                       THEN 'handoff' ELSE status END,
         status_updated_at = CASE WHEN COALESCE(status, 'unsubscribed') = 'unsubscribed'
                                  THEN now() ELSE status_updated_at END`
      : ''
    await db.query(
      `UPDATE conversations
          SET last_message = $2, last_message_at = now(), unread = 0${humanTakeover}
        WHERE id = $1`,
      [input.conversationId, input.preview ?? input.body],
    )
    // Re-read through the standard select so the returned message carries the
    // hydrated reply preview (author/body of the quoted message).
    const full = await db.query<MessageRow>(
      `SELECT ${MESSAGE_SELECT} FROM messages m ${MESSAGE_REPLY_JOIN} WHERE m.id = $1`,
      [rows[0].id],
    )
    return full[0] ? toMessage(full[0]) : null
  })
}

/**
 * Resolve everything the worker needs to act on a specific message (reply /
 * react / delete / forward), scoped to the owning manager. Returns null when
 * the manager doesn't own the message or it has no provider id yet.
 */
export async function getMessageDispatch(
  messageId: string,
  managerId: string,
): Promise<{
  providerMessageId: string | null
  contactHandle: string
  channelId: string
  channelType: ChannelType
  direction: 'in' | 'out'
} | null> {
  const rows = await query<{
    provider_message_id: string | null
    contact_handle: string
    channel_id: string
    type: ChannelType
    direction: 'in' | 'out'
  }>(
    `SELECT m.provider_message_id, c.contact_handle, c.channel_id, ch.type,
            m.direction
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1 AND c.manager_id = $2`,
    [messageId, managerId],
  )
  if (rows.length === 0) return null
  return {
    providerMessageId: rows[0].provider_message_id,
    contactHandle: rows[0].contact_handle,
    channelId: rows[0].channel_id,
    channelType: rows[0].type,
    direction: rows[0].direction,
  }
}

/**
 * Set (or clear, with null) the operator's emoji reaction on a message. Only a
 * single "fromMe" reaction is kept; any contact reactions are preserved.
 * Scoped to the owning manager. Returns true when a row was updated.
 */
export async function setMessageReaction(
  messageId: string,
  managerId: string,
  emoji: string | null,
): Promise<boolean> {
  const owned = await query<{ reactions: unknown }>(
    `SELECT m.reactions FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.manager_id = $2`,
    [messageId, managerId],
  )
  if (owned.length === 0) return false
  const existing: MessageReaction[] = Array.isArray(owned[0].reactions)
    ? (owned[0].reactions as MessageReaction[])
    : []
  const others = existing.filter((r) => !r.fromMe)
  const next = emoji ? [...others, { emoji, fromMe: true }] : others
  await query('UPDATE messages SET reactions = $2 WHERE id = $1', [
    messageId,
    JSON.stringify(next),
  ])
  return true
}

/**
 * Soft-delete a message (sets deleted_at + deleted_origin='self'). The body and
 * any media are PRESERVED so the thread keeps the original content with a
 * "deleted" marker instead of losing it. Scoped to the owning manager. Returns
 * true when a row was updated. Idempotent: only stamps a row that isn't already
 * marked deleted.
 */
export async function markMessageDeleted(
  messageId: string,
  managerId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE messages m
        SET deleted_at = COALESCE(m.deleted_at, now()),
            deleted_origin = 'self'
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND m.id = $1 AND c.manager_id = $2
      RETURNING m.id`,
    [messageId, managerId],
  )
  return rows.length > 0
}

/**
 * Resolve the channel a message belongs to, but only if it is owned by the
 * given manager. Used by the media proxy route to authorize streaming.
 * Returns the channel id + type, or null when the manager doesn't own it.
 */
export async function getMessageOwner(
  messageId: string,
  managerId: string,
): Promise<{ channelId: string; channelType: ChannelType } | null> {
  const rows = await query<{ channel_id: string; type: ChannelType }>(
    `SELECT ch.id AS channel_id, ch.type
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1 AND c.manager_id = $2`,
    [messageId, managerId],
  )
  if (rows.length === 0) return null
  return { channelId: rows[0].channel_id, channelType: rows[0].type }
}

/**
 * Resolve a channel id + type owned by the manager. Used by the sticker proxy
 * routes and sendStickerAction to authorize worker calls.
 */
export async function getChannelOwner(
  channelId: string,
  managerId: string,
): Promise<{ channelId: string; channelType: ChannelType } | null> {
  const rows = await query<{ id: string; type: ChannelType }>(
    'SELECT id, type FROM channels WHERE id = $1 AND manager_id = $2',
    [channelId, managerId],
  )
  if (rows.length === 0) return null
  return { channelId: rows[0].id, channelType: rows[0].type }
}

/**
 * Pin or clear a lead's manual status. Pass null to clear the manual override
 * and fall back to the auto-derived status. Scoped to the owning manager.
 * Returns true when a row was updated.
 */
export async function setConversationStatus(
  conversationId: string,
  managerId: string,
  status: LeadStatus | null,
  detail: NotLiquidReason | null = null,
): Promise<boolean> {
  // The reason sub-status only applies to «Не ликвид»; ignore it otherwise so
  // we never violate the conversations_status_detail_check constraint.
  const effectiveDetail = status === 'not_liquid' ? detail : null
  // $3/$4 are cast to ::text explicitly. Without the cast, Postgres cannot infer
  // the parameter's type when the value is NULL (it only appears in SET / CASE
  // WHEN ... IS NULL), which throws "could not determine data type of parameter".
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET status = $3::text,
            status_detail = $4::text,
            status_updated_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [conversationId, managerId, status, effectiveDetail],
  )
  return rows.length > 0
}

/**
 * Manager: mark a conversation as "no reply needed" by stamping the dismissal
 * time. The thread stops counting as awaiting a reply until a newer inbound
 * message arrives. Pass `clear` to undo (set back to NULL). Scoped to the owner.
 */
export async function dismissReplyReminder(
  conversationId: string,
  managerId: string,
  clear = false,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET reply_dismissed_at = ${clear ? 'NULL' : 'now()'}
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [conversationId, managerId],
  )
  return rows.length > 0
}

/**
 * Manager: mute (silence) or unmute a conversation. A muted thread sends no push
 * notifications, is hidden from the default inbox list and excluded from the
 * "awaiting reply" sorting/reminders. Scoped to the owning manager.
 */
export async function setConversationMuted(
  conversationId: string,
  managerId: string,
  muted: boolean,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET muted = $3
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [conversationId, managerId, muted],
  )
  return rows.length > 0
}

/** True when this conversation is muted. Used by the push dispatcher. */
export async function isConversationMuted(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ muted: boolean }>(
    `SELECT muted FROM conversations WHERE id = $1`,
    [conversationId],
  )
  return rows.length > 0 ? Boolean(rows[0].muted) : false
}

/**
 * True when this conversation is a client-simulator dialog (is_simulated).
 *
 * This is the delivery kill-switch: simulator dialogs live on REAL channels
 * (a real channel_id + type like vk/whatsapp/max), so without this guard an
 * AI-manager reply to a fake client would be pushed to a real external
 * provider. The provider dispatchers call this and hard no-op for simulated
 * conversations, keeping the entire simulated exchange inside our own DB while
 * the AI manager still treats the dialog exactly like a real one.
 *
 * Fails safe: on any error it returns true (treat as simulated → do NOT
 * deliver), because leaking a fake message to a real user is far worse than
 * skipping a delivery.
 */
export async function isConversationSimulated(
  conversationId: string,
): Promise<boolean> {
  try {
    const rows = await query<{ is_simulated: boolean }>(
      `SELECT is_simulated FROM conversations WHERE id = $1`,
      [conversationId],
    )
    // Unknown conversation → not simulated (nothing to protect).
    return rows.length > 0 ? Boolean(rows[0].is_simulated) : false
  } catch (err) {
    console.error('isConversationSimulated: guard query failed:', err)
    return true
  }
}

/* ------------------------- Conversation transfer ------------------------- */

export interface TransferTarget {
  id: string
  name: string
  /** True when the colleague is on lunch (still selectable, shown greyed). */
  onLunch: boolean
}

/**
 * Active managers a conversation can be handed off to, excluding the caller and
 * any blocked accounts. On-lunch managers are still returned (a manual transfer
 * is an explicit choice) but flagged so the UI can de-emphasise them.
 */
export async function listTransferTargets(
  excludeManagerId: string,
): Promise<TransferTarget[]> {
  const rows = await query<{
    id: string
    name: string
    on_lunch: boolean | null
  }>(
    `SELECT id, name, on_lunch
       FROM managers
      WHERE status = 'active' AND id <> $1
      ORDER BY on_lunch ASC, name ASC`,
    [excludeManagerId],
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    onLunch: r.on_lunch ?? false,
  }))
}

/**
 * Hand a conversation off to another manager. Ownership-scoped: only the
 * current owner (fromManagerId) can transfer, which also prevents transferring
 * a thread you can't see. Clears the "reply dismissed" marker so the new owner
 * sees it as awaiting a reply, and records the audit row atomically. Migration
 * 041 is therefore required and is applied by the supported migration runner.
 */
export async function transferConversation(input: {
  conversationId: string
  fromManagerId: string
  toManagerId: string
  note?: string
}): Promise<boolean> {
  // Guard: the target must be an existing active manager (and not the caller).
  const target = await query<{ id: string }>(
    `SELECT id FROM managers WHERE id = $1 AND status = 'active'`,
    [input.toManagerId],
  )
  if (target.length === 0 || input.toManagerId === input.fromManagerId) {
    return false
  }

  return withTransaction(async (db) => {
    const rows = await db.query<{ id: string }>(
      `UPDATE conversations
          SET manager_id = $3, reply_dismissed_at = NULL
        WHERE id = $1 AND manager_id = $2
        RETURNING id`,
      [input.conversationId, input.fromManagerId, input.toManagerId],
    )
    if (rows.length === 0) return false

    await db.query(
      `INSERT INTO conversation_transfers
         (conversation_id, from_manager_id, to_manager_id, note)
       VALUES ($1, $2, $3, $4)`,
      [
        input.conversationId,
        input.fromManagerId,
        input.toManagerId,
        (input.note ?? '').slice(0, 500),
      ],
    )
    return true
  })
}

/**
 * Admin (God-mode) bulk hand-off: move a batch of conversations to another
 * manager, regardless of who currently owns them. Unlike transferConversation
 * this is NOT ownership-scoped — the secret panel operates above any single
 * manager — but it keeps the exact same side effects per moved thread:
 *   - conversations.manager_id is repointed (which fires the realtime trigger,
 *     so the thread pops into the new owner's inbox live);
 *   - reply_dismissed_at is cleared so the new owner sees it as awaiting reply;
 *   - a conversation_transfers audit row records the previous → new owner.
 *
 * Threads already owned by the target, or ids that don't exist, are skipped.
 * Returns the number of conversations actually moved.
 */
export async function adminReassignConversations(input: {
  conversationIds: string[]
  toManagerId: string
  note?: string
}): Promise<number> {
  const ids = input.conversationIds.filter(Boolean)
  if (ids.length === 0) return 0

  // Target must be a real, active manager.
  const target = await query<{ id: string }>(
    `SELECT id FROM managers WHERE id = $1 AND status = 'active'`,
    [input.toManagerId],
  )
  if (target.length === 0) return 0

  const note = (input.note ?? '').slice(0, 500)

  return withTransaction(async (db) => {
    // Snapshot previous owners BEFORE the update so the audit trail is accurate,
    // then move only the threads whose owner actually changes.
    const moved = await db.query<{ id: string; from_id: string | null }>(
      `WITH prev AS (
         SELECT id, manager_id AS from_id
           FROM conversations
          WHERE id = ANY($1::uuid[])
       )
       UPDATE conversations c
          SET manager_id = $2, reply_dismissed_at = NULL
         FROM prev
        WHERE c.id = prev.id
          AND c.manager_id IS DISTINCT FROM $2
       RETURNING c.id AS id, prev.from_id AS from_id`,
      [ids, input.toManagerId],
    )
    if (moved.length === 0) return 0

    // One audit row per moved thread (from previous owner → new owner).
    // unnest(a, b) in FROM zips the two arrays positionally and preserves NULL
    // previous owners (an unassigned thread has from_manager_id = NULL).
    await db.query(
      `INSERT INTO conversation_transfers
         (conversation_id, from_manager_id, to_manager_id, note)
       SELECT t.cid, t.fid, $3, $4
         FROM unnest($1::uuid[], $2::uuid[]) AS t(cid, fid)`,
      [
        moved.map((r) => r.id),
        moved.map((r) => r.from_id),
        input.toManagerId,
        note,
      ],
    )
    return moved.length
  })
}


/* Live chat widget — extracted to ./data/livechat */
