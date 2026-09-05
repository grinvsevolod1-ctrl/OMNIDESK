import { query, one } from './db.js'
import {
  saveMediaFile,
  readMediaFile,
  deleteMediaFile,
} from './media-store.js'

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
  providerMessageId: string | null
  contactHandle: string | null
} | null> {
  const row = await one<{
    channel_id: string
    type: 'telegram' | 'whatsapp' | 'livechat'
    media_type: string | null
    media_mime: string | null
    media_name: string | null
    media_ref: unknown
    provider_message_id: string | null
    contact_handle: string | null
  }>(
    `SELECT c.channel_id, ch.type,
            m.media_type, m.media_mime, m.media_name, m.media_ref,
            m.provider_message_id, c.contact_handle
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
    providerMessageId: row.provider_message_id,
    contactHandle: row.contact_handle,
  }
}

/* --------------------- Durable media + edit history -------------------- */

/**
 * Persist the raw media bytes of a message and point the message at the stored
 * blob, so the file survives the contact later deleting or editing the
 * original on their side. Bytes go to the LOCAL FILESYSTEM (scripts/107,
 * MEDIA_STORE_DIR on the same VPS) with only the absolute path in Postgres;
 * if the disk write fails (full disk, bad mount) we fall back to bytea so the
 * archive guarantee still holds. Idempotent: if the message already has a
 * stored blob we skip (a replay never duplicates bytes). Returns the blob id
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

  let filePath: string | null = null
  try {
    filePath = await saveMediaFile(bytes, mime)
  } catch {
    filePath = null // every storage tier unavailable — bytea fallback below
  }

  let blob: { id: string } | null = null
  try {
    blob = await one<{ id: string }>(
      `INSERT INTO media_blobs (bytes, mime, name, byte_size, file_path)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [filePath ? null : bytes, mime, name, bytes.byteLength, filePath],
    )
  } catch (err) {
    // Don't leak an orphaned file when the row never got created.
    if (filePath) await deleteMediaFile(filePath)
    throw err
  }
  if (!blob) {
    if (filePath) await deleteMediaFile(filePath)
    return null
  }
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

/**
 * Materialize a blob row into bytes: disk-backed rows read from the local
 * filesystem, legacy rows still carry bytea inline. Null when both are gone.
 */
async function resolveBlobBytes(row: {
  bytes: Buffer | null
  file_path: string | null
  mime: string | null
  name: string | null
}): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  if (row.file_path) {
    const fromDisk = await readMediaFile(row.file_path)
    if (fromDisk) return { bytes: fromDisk, mime: row.mime, name: row.name }
  }
  if (row.bytes) {
    return { bytes: Buffer.from(row.bytes), mime: row.mime, name: row.name }
  }
  return null
}

/** Stored media bytes for a message (from its current blob), or null. */
export async function getStoredMediaBytes(
  messageId: string,
): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  const row = await one<{
    bytes: Buffer | null
    file_path: string | null
    mime: string | null
    name: string | null
  }>(
    `SELECT b.bytes, b.file_path, b.mime, b.name
       FROM messages m
       JOIN media_blobs b ON b.id = m.media_blob_id
      WHERE m.id = $1`,
    [messageId],
  )
  if (!row) return null
  return resolveBlobBytes(row)
}

/** Stored media bytes for a specific edit-history version, or null. */
export async function getStoredEditMediaBytes(
  editId: string,
): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  const row = await one<{
    bytes: Buffer | null
    file_path: string | null
    mime: string | null
    name: string | null
  }>(
    `SELECT b.bytes, b.file_path, b.mime, b.name
       FROM message_edits e
       JOIN media_blobs b ON b.id = e.media_blob_id
      WHERE e.id = $1`,
    [editId],
  )
  if (!row) return null
  return resolveBlobBytes(row)
}

/**
 * Background offload: move one batch of legacy bytea blobs to the local
 * filesystem and NULL the moved bytes, shrinking the table over time without a
 * blocking one-shot migration. Called from a periodic worker sweep. Returns
 * how many blobs were moved (0 = nothing legacy left, sweep can idle).
 */
export async function offloadLegacyMediaBlobs(batch = 25): Promise<number> {
  const rows = await query<{ id: string; bytes: Buffer; mime: string | null }>(
    `SELECT id, bytes, mime FROM media_blobs
      WHERE bytes IS NOT NULL AND file_path IS NULL
      ORDER BY created_at
      LIMIT $1`,
    [batch],
  )
  let moved = 0
  for (const row of rows) {
    try {
      const filePath = await saveMediaFile(Buffer.from(row.bytes), row.mime)
      await query(
        `UPDATE media_blobs SET file_path = $2, bytes = NULL WHERE id = $1`,
        [row.id, filePath],
      )
      moved++
    } catch {
      // Disk trouble — stop the batch; the sweep retries next tick and the
      // data is still safe in bytea.
      break
    }
  }
  return moved
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
