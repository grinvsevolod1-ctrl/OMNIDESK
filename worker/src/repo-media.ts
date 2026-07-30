import { query, one } from './db.js'

/**
 * Worker-side message media repository, extracted from repo.ts and re-exported
 * from it for backward compatibility. Resolves media for re-download, stores/
 * reads cached media bytes (original + edited), and records message edits.
 */

/**
 * Resolve everything needed to re-download a message's media: which channel /
 * session owns it, the media kind/mime/name and the provider `ref` JSON. Used
 * by the worker's GET /media endpoint.
 */
export async function getMessageMedia(messageId: string): Promise<{
  channelId: string
  channelType: 'telegram' | 'whatsapp' | 'livechat'
  mediaType: string | null
  mediaMime: string | null
  mediaName: string | null
  mediaRef: unknown
} | null> {
  const row = await one<{
    channel_id: string
    type: 'telegram' | 'whatsapp' | 'livechat'
    media_type: string | null
    media_mime: string | null
    media_name: string | null
    media_ref: unknown
  }>(
    `SELECT c.channel_id, ch.type,
            m.media_type, m.media_mime, m.media_name, m.media_ref
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1`,
    [messageId],
  )
  if (!row) return null
  return {
    channelId: row.channel_id,
    channelType: row.type,
    mediaType: row.media_type,
    mediaMime: row.media_mime,
    mediaName: row.media_name,
    // pg returns jsonb already parsed; pass through as-is.
    mediaRef: row.media_ref,
  }
}

/* --------------------- Durable media + edit history -------------------- */

/**
 * Persist the raw media bytes of a message into Postgres (bytea) and point the
 * message at the stored blob, so the file survives the contact later deleting
 * or editing the original on their side. Idempotent: if the message already has
 * a stored blob we skip (a replay never duplicates bytes). Returns the blob id
 * or null when nothing was stored (e.g. row already had one).
 */
export async function storeMessageMediaBytes(
  messageId: string,
  bytes: Buffer,
  mime: string | null,
  name: string | null,
): Promise<string | null> {
  // Skip when this message already has stored bytes (idempotent on replays).
  const existing = await one<{ media_blob_id: string | null }>(
    `SELECT media_blob_id FROM messages WHERE id = $1`,
    [messageId],
  )
  if (!existing) return null
  if (existing.media_blob_id) return existing.media_blob_id

  const blob = await one<{ id: string }>(
    `INSERT INTO media_blobs (bytes, mime, name, byte_size)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [bytes, mime, name, bytes.byteLength],
  )
  if (!blob) return null
  await query(`UPDATE messages SET media_blob_id = $2 WHERE id = $1`, [
    messageId,
    blob.id,
  ])
  return blob.id
}

/** True when a message still needs its media bytes stored (blob missing). */
export async function messageNeedsMediaBytes(
  messageId: string,
): Promise<boolean> {
  const row = await one<{ media_type: string | null; media_blob_id: string | null }>(
    `SELECT media_type, media_blob_id FROM messages WHERE id = $1`,
    [messageId],
  )
  return Boolean(row && row.media_type && !row.media_blob_id)
}

/** Stored media bytes for a message (from its current blob), or null. */
export async function getStoredMediaBytes(
  messageId: string,
): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  const row = await one<{ bytes: Buffer; mime: string | null; name: string | null }>(
    `SELECT b.bytes, b.mime, b.name
       FROM messages m
       JOIN media_blobs b ON b.id = m.media_blob_id
      WHERE m.id = $1`,
    [messageId],
  )
  if (!row) return null
  return { bytes: Buffer.from(row.bytes), mime: row.mime, name: row.name }
}

/** Stored media bytes for a specific edit-history version, or null. */
export async function getStoredEditMediaBytes(
  editId: string,
): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  const row = await one<{ bytes: Buffer; mime: string | null; name: string | null }>(
    `SELECT b.bytes, b.mime, b.name
       FROM message_edits e
       JOIN media_blobs b ON b.id = e.media_blob_id
      WHERE e.id = $1`,
    [editId],
  )
  if (!row) return null
  return { bytes: Buffer.from(row.bytes), mime: row.mime, name: row.name }
}

/**
 * Record an edit to an inbound message identified by its provider id. Snapshots
 * the CURRENT stored version into message_edits (append-only history) and then
 * overwrites the live row with the new content. No-op when the content is
 * unchanged (Telegram re-sends edit updates for reactions/views too). Returns
 * the message id + whether media changed, so the caller can store new bytes.
 */
export async function recordMessageEditByProviderId(
  channelId: string,
  providerMessageId: string,
  next: {
    body: string
    mediaType?: string | null
    mediaMime?: string | null
    mediaName?: string | null
  },
): Promise<{ messageId: string; mediaChanged: boolean } | null> {
  const row = await one<{
    id: string
    body: string
    author: string
    media_type: string | null
    media_mime: string | null
    media_name: string | null
    media_blob_id: string | null
    edit_count: number
  }>(
    `SELECT m.id, m.body, m.author, m.media_type, m.media_mime, m.media_name,
            m.media_blob_id, m.edit_count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1 AND m.provider_message_id = $2
      LIMIT 1`,
    [channelId, providerMessageId],
  )
  if (!row) return null

  const nextType = next.mediaType ?? row.media_type
  const mediaChanged = (next.mediaType ?? null) !== (row.media_type ?? null)
  // Nothing actually changed (text identical, media kind identical): ignore.
  if (row.body === next.body && !mediaChanged) {
    return { messageId: row.id, mediaChanged: false }
  }

  const nextVersion = (row.edit_count ?? 0) + 1
  // Snapshot the version we're about to overwrite (keeps its media blob ref, so
  // the old photo/video is still viewable from history).
  await query(
    `INSERT INTO message_edits
       (message_id, version, body, media_type, media_mime, media_name, media_blob_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (message_id, version) DO NOTHING`,
    [
      row.id,
      nextVersion,
      row.body,
      row.media_type,
      row.media_mime,
      row.media_name,
      row.media_blob_id,
    ],
  )

  // Overwrite the live row. When media changed, drop the old blob pointer so the
  // caller can attach freshly downloaded bytes (the old blob stays referenced by
  // the history row above, so nothing is lost).
  await query(
    `UPDATE messages
        SET body = $2,
            media_type = $3, media_mime = $4, media_name = $5,
            media_blob_id = CASE WHEN $6 THEN NULL ELSE media_blob_id END,
            edited_at = now(),
            edit_count = $7
      WHERE id = $1`,
    [
      row.id,
      next.body,
      nextType,
      mediaChanged ? (next.mediaMime ?? null) : row.media_mime,
      mediaChanged ? (next.mediaName ?? null) : row.media_name,
      mediaChanged,
      nextVersion,
    ],
  )
  return { messageId: row.id, mediaChanged }
}
