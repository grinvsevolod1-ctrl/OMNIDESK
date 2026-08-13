/**
 * Conversations & messages: listing, status/lead, mute, reactions, dispatch,
 * read state, reply reminders and conversation transfer.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { query } from '../db'
import type {
  ChannelType,
  Conversation,
  LeadStatus,
  NotLiquidReason,
} from '../types'
import {
  conversationColumns,
  effectiveStatusSql,
  toConversation,
  type ConversationRow,
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
  // Точный учёт прочтения (см. 125_message_read_at.sql): состояние читаемости
  // живёт на самих сообщениях, а не только в счётчике диалога.
  await query(
    `UPDATE messages
        SET read_at = now()
      WHERE conversation_id = $1 AND direction = 'in' AND read_at IS NULL`,
    [conversationId],
  )
  return {
    channelId: rows[0].channel_id,
    channelType: rows[0].channel_type,
    contactHandle: rows[0].contact_handle,
  }
}

/*
 * Message reads/writes inside a thread (hydration, batch preload, older-page
 * loading, in-thread search, SSE gap recovery, outbound insert) moved to
 * conversation-messages.ts; re-exported for compatibility.
 */
export {
  addMessage,
  getMessagesSince,
  listMessages,
  listMessagesBefore,
  listMessagesForConversations,
  searchConversationMessages,
} from './conversation-messages'

/*
 * Message dispatch/reaction/edit/ownership moved to message-admin.ts;
 * re-exported for compatibility.
 */
export {
  editMessageBody,
  getChannelOwner,
  getMessageDispatch,
  getMessageOwner,
  getMessageOwnerAdmin,
  markMessageDeleted,
  setMessageReaction,
} from './message-admin'

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

/*
 * Conversation transfer (manager hand-off, admin bulk reassignment, transfer
 * targets) moved to conversation-transfer.ts; re-exported for compatibility.
 */
export {
  adminReassignConversations,
  listConversationIdsForManager,
  listTransferTargets,
  transferConversation,
  type TransferTarget,
} from './conversation-transfer'

/* Live chat widget — extracted to ./data/livechat */
