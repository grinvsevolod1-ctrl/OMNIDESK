/**
 * Message reads/writes inside a conversation: thread hydration, batch preload,
 * older-history paging, in-thread search, SSE gap recovery and outbound insert.
 * Split out of conversations.ts (which re-exports everything from here).
 */
import { query, withTransaction } from '../db'
import type { MediaType, Message } from '../types'
import {
  MESSAGE_REPLY_JOIN,
  MESSAGE_SELECT,
  toMessage,
  type MessageRow,
} from './shared'

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

/**
 * Per-conversation slice for the inbox BATCH preload. Much smaller than
 * MESSAGE_HISTORY_LIMIT on purpose: the batch runs for EVERY visible thread on
 * every inbox page load (worst case 500 conversations), so 300 each meant up
 * to 150 000 rows serialized into the RSC payload — megabytes of JSON per
 * navigation. 30 covers the visible tail of any thread the manager opens;
 * older history lazy-loads through loadOlderMessagesAction on scroll, which
 * the UI already supports.
 */
const BATCH_PRELOAD_LIMIT = 30

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
 * Batch loader for the inbox: the most-recent BATCH_PRELOAD_LIMIT messages for
 * EACH of the given conversations, resolved in a SINGLE round-trip.
 *
 * The inbox page hydrates transcripts for every visible thread at once. Doing
 * that as one `listMessages` call per conversation is a classic N+1 — hundreds
 * of serial queries on a busy panel. Here a window function ranks each
 * conversation's messages newest-first and we keep only the top slice per
 * partition, so Postgres returns all threads' recent history in one shot.
 *
 * Manager-scoped via the join (ids that aren't the caller's are silently
 * dropped). Returns a map keyed by conversation id; each list is chronological
 * (oldest-first) to match `listMessages`. Conversations with no messages are
 * simply absent from the map.
 */
export async function listMessagesForConversations(
  conversationIds: string[],
  managerId: string,
): Promise<Record<string, Message[]>> {
  const byId: Record<string, Message[]> = {}
  if (conversationIds.length === 0) return byId

  const rows = await query<MessageRow & { rn: number }>(
    `SELECT id, conversation_id, direction, body, author, created_at,
            media_type, media_mime, media_name, reactions, deleted_at,
            deleted_origin, status, error_reason, edited_at, edit_count,
            reply_to_id, reply_to_author, reply_to_body, reply_to_media_type
       FROM (
         SELECT ${MESSAGE_SELECT},
                ROW_NUMBER() OVER (
                  PARTITION BY m.conversation_id ORDER BY m.created_at DESC
                ) AS rn
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           ${MESSAGE_REPLY_JOIN}
          WHERE c.manager_id = $1 AND m.conversation_id = ANY($2)
       ) ranked
      WHERE rn <= $3
      ORDER BY conversation_id ASC, created_at ASC`,
    [managerId, conversationIds, BATCH_PRELOAD_LIMIT],
  )

  // Rows already arrive grouped by conversation and oldest-first, so a single
  // pass builds the per-thread transcripts without any extra sorting.
  for (const row of rows) {
    const list = byId[row.conversation_id] ?? (byId[row.conversation_id] = [])
    list.push(toMessage(row))
  }
  return byId
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
 * Поиск по тексту сообщений одного диалога (кнопка-лупа в треде).
 * Возвращает только id/дату/сниппет совпадений от НОВЫХ к старым — клиент
 * навигируется по ним, догружая историю по мере необходимости.
 * Manager-scoped через join: чужой диалог просто даёт [].
 */
export async function searchConversationMessages(
  conversationId: string,
  managerId: string,
  q: string,
  limit = 200,
): Promise<Array<{ id: string; createdAt: string; snippet: string }>> {
  const needle = q.trim()
  if (!needle) return []
  const rows = await query<{ id: string; created_at: Date; body: string }>(
    `SELECT m.id, m.created_at, m.body
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1
        AND c.manager_id = $2
        AND m.deleted_at IS NULL
        AND m.body ILIKE '%' || $3 || '%'
      ORDER BY m.created_at DESC
      LIMIT $4`,
    [conversationId, managerId, needle, Math.min(Math.max(1, limit), 200)],
  )
  return rows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    snippet: r.body.length > 90 ? `${r.body.slice(0, 90)}…` : r.body,
  }))
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
    // Ответ (человека или ИИ) означает, что входящие прочитаны — штампуем
    // read_at, чтобы состояние сообщений совпадало с обнулённым счётчиком.
    await db.query(
      `UPDATE messages
          SET read_at = now()
        WHERE conversation_id = $1 AND direction = 'in' AND read_at IS NULL`,
      [input.conversationId],
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
