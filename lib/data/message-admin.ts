/**
 * Message-level operations: dispatch resolution for the worker, reactions,
 * delete/edit, and message/channel ownership checks. Split out of
 * conversations.ts; re-exported there so existing imports keep working.
 */
import { query, withTransaction } from '../db'
import type { ChannelType, MessageReaction } from '../types'

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
 * Edit the body of the manager's own outgoing message, Telegram-style. The
 * previous version is snapshotted into the append-only `message_edits` history
 * before the live row is overwritten (same trail the god-panel edits use), and
 * the conversation list preview is refreshed when the edited message is the
 * newest one. Scoped to the owning manager and outbound messages only.
 * Returns false when nothing changed (not found, foreign, deleted, same text).
 */
export async function editMessageBody(
  messageId: string,
  managerId: string,
  body: string,
): Promise<boolean> {
  const rows = await query<{
    id: string
    conversation_id: string
    body: string
    media_type: string | null
    media_mime: string | null
    media_name: string | null
    media_blob_id: string | null
    edit_count: number
    deleted_at: string | null
  }>(
    `SELECT m.id, m.conversation_id, m.body, m.media_type, m.media_mime,
            m.media_name, m.media_blob_id, m.edit_count, m.deleted_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.manager_id = $2 AND m.direction = 'out'
      LIMIT 1`,
    [messageId, managerId],
  )
  const prev = rows[0]
  if (!prev || prev.deleted_at || prev.body === body) return false

  const nextVersion = (prev.edit_count ?? 0) + 1
  await withTransaction(async (db) => {
    await db.query(
      `INSERT INTO message_edits
         (message_id, version, body, media_type, media_mime, media_name, media_blob_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (message_id, version) DO NOTHING`,
      [
        prev.id,
        nextVersion,
        prev.body,
        prev.media_type,
        prev.media_mime,
        prev.media_name,
        prev.media_blob_id,
      ],
    )
    await db.query(
      `UPDATE messages
          SET body = $2, edited_at = now(), edit_count = $3
        WHERE id = $1`,
      [prev.id, body, nextVersion],
    )
    // Refresh the list preview only when this message IS the latest one.
    await db.query(
      `UPDATE conversations c
          SET last_message = $2
        WHERE c.id = $1
          AND NOT EXISTS (
            SELECT 1 FROM messages n
             WHERE n.conversation_id = c.id
               AND n.deleted_at IS NULL
               AND n.created_at > (SELECT created_at FROM messages WHERE id = $3)
          )`,
      [prev.conversation_id, body, prev.id],
    )
  })
  return true
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
 * Admin-wide variant of `getMessageOwner`: resolves the channel for ANY message
 * with no manager scoping. Callers MUST have verified an admin-level gate
 * (god passcode / messenger passcode) before using it — it powers media
 * streaming for the god console + god messenger.
 */
export async function getMessageOwnerAdmin(
  messageId: string,
): Promise<{ channelId: string; channelType: ChannelType } | null> {
  const rows = await query<{ channel_id: string; type: ChannelType }>(
    `SELECT ch.id AS channel_id, ch.type
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1`,
    [messageId],
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

/* -------------------------------------------------------------------------- *
 *  Curator-scoped mirrors (migration 151).                                    *
 *                                                                             *
 *  A conversation TRANSFERRED to a curator carries conversations.curator_id.  *
 *  These variants mirror the manager operations above verbatim but scope by   *
 *  `c.curator_id = $` instead of `c.manager_id = $`, so a curator can only    *
 *  ever touch messages in a thread that was actually handed to them (same     *
 *  IDOR shape as the manager path). The owning manager's id is returned too   *
 *  because provider delivery (worker job queue) still runs under the account  *
 *  owner — the curator never owns a Telegram session/channel of their own.    *
 * -------------------------------------------------------------------------- */

/** Curator-scoped `getMessageDispatch`; also returns the owner manager id. */
export async function getMessageDispatchForCurator(
  messageId: string,
  curatorId: string,
): Promise<{
  managerId: string
  providerMessageId: string | null
  contactHandle: string
  channelId: string
  channelType: ChannelType
  direction: 'in' | 'out'
} | null> {
  const rows = await query<{
    manager_id: string
    provider_message_id: string | null
    contact_handle: string
    channel_id: string
    type: ChannelType
    direction: 'in' | 'out'
  }>(
    `SELECT c.manager_id, m.provider_message_id, c.contact_handle,
            c.channel_id, ch.type, m.direction
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1 AND c.curator_id = $2`,
    [messageId, curatorId],
  )
  if (rows.length === 0) return null
  return {
    managerId: rows[0].manager_id,
    providerMessageId: rows[0].provider_message_id,
    contactHandle: rows[0].contact_handle,
    channelId: rows[0].channel_id,
    channelType: rows[0].type,
    direction: rows[0].direction,
  }
}

/** Curator-scoped `setMessageReaction`. */
export async function setMessageReactionForCurator(
  messageId: string,
  curatorId: string,
  emoji: string | null,
): Promise<boolean> {
  const owned = await query<{ reactions: unknown }>(
    `SELECT m.reactions FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.curator_id = $2`,
    [messageId, curatorId],
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

/** Curator-scoped `markMessageDeleted`. */
export async function markMessageDeletedForCurator(
  messageId: string,
  curatorId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE messages m
        SET deleted_at = COALESCE(m.deleted_at, now()),
            deleted_origin = 'self'
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND m.id = $1 AND c.curator_id = $2
      RETURNING m.id`,
    [messageId, curatorId],
  )
  return rows.length > 0
}

/** Curator-scoped `editMessageBody` (own outgoing messages only). */
export async function editMessageBodyForCurator(
  messageId: string,
  curatorId: string,
  body: string,
): Promise<boolean> {
  const rows = await query<{
    id: string
    conversation_id: string
    body: string
    media_type: string | null
    media_mime: string | null
    media_name: string | null
    media_blob_id: string | null
    edit_count: number
    deleted_at: string | null
  }>(
    `SELECT m.id, m.conversation_id, m.body, m.media_type, m.media_mime,
            m.media_name, m.media_blob_id, m.edit_count, m.deleted_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.curator_id = $2 AND m.direction = 'out'
      LIMIT 1`,
    [messageId, curatorId],
  )
  const prev = rows[0]
  if (!prev || prev.deleted_at || prev.body === body) return false

  const nextVersion = (prev.edit_count ?? 0) + 1
  await withTransaction(async (db) => {
    await db.query(
      `INSERT INTO message_edits
         (message_id, version, body, media_type, media_mime, media_name, media_blob_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (message_id, version) DO NOTHING`,
      [
        prev.id,
        nextVersion,
        prev.body,
        prev.media_type,
        prev.media_mime,
        prev.media_name,
        prev.media_blob_id,
      ],
    )
    await db.query(
      `UPDATE messages
          SET body = $2, edited_at = now(), edit_count = $3
        WHERE id = $1`,
      [prev.id, body, nextVersion],
    )
    await db.query(
      `UPDATE conversations c
          SET last_message = $2
        WHERE c.id = $1
          AND NOT EXISTS (
            SELECT 1 FROM messages n
             WHERE n.conversation_id = c.id
               AND n.deleted_at IS NULL
               AND n.created_at > (SELECT created_at FROM messages WHERE id = $3)
          )`,
      [prev.conversation_id, body, prev.id],
    )
  })
  return true
}

/**
 * Curator-scoped variant of `getMessageOwner`. Mirrors it exactly but checks
 * `c.curator_id = $2` instead of `c.manager_id = $2` — a curator only owns
 * messages that live in a conversation TRANSFERRED to them (recordTransfer).
 * Used by the media route and message-edit-history route so a curator's own
 * inbox can stream/download the same photos, videos, voice notes and files a
 * manager sees, without widening a manager session's own scope.
 */
export async function getMessageOwnerForCurator(
  messageId: string,
  curatorId: string,
): Promise<{ channelId: string; channelType: ChannelType } | null> {
  const rows = await query<{ channel_id: string; type: ChannelType }>(
    `SELECT ch.id AS channel_id, ch.type
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1 AND c.curator_id = $2`,
    [messageId, curatorId],
  )
  if (rows.length === 0) return null
  return { channelId: rows[0].channel_id, channelType: rows[0].type }
}

/**
 * Curator-scoped channel resolver for the sticker proxy routes. A curator can
 * reach a channel only THROUGH a conversation transferred to them on it, so we
 * authorize by the existence of such a conversation and hand back the channel
 * type plus the owning manager id (the worker call runs under the owner).
 */
export async function getChannelOwnerForCurator(
  channelId: string,
  curatorId: string,
): Promise<{
  channelId: string
  channelType: ChannelType
  managerId: string
} | null> {
  const rows = await query<{
    id: string
    type: ChannelType
    manager_id: string
  }>(
    `SELECT ch.id, ch.type, ch.manager_id
       FROM channels ch
      WHERE ch.id = $1
        AND EXISTS (
          SELECT 1 FROM conversations c
           WHERE c.channel_id = ch.id AND c.curator_id = $2
        )
      LIMIT 1`,
    [channelId, curatorId],
  )
  if (rows.length === 0) return null
  return {
    channelId: rows[0].id,
    channelType: rows[0].type,
    managerId: rows[0].manager_id,
  }
}
