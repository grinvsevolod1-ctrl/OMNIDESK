/**
 * Durable media + edit-history archive (panel side).
 *
 * The worker owns Telegram; these helpers give the serverless webhook channels
 * (VK / WhatsApp / MAX) and the media proxy the same guarantees:
 *
 *  - Media bytes are copied into Postgres (`media_blobs`, bytea) so a photo /
 *    video / voice note survives the contact later deleting or editing the
 *    original on their side — the file is ours forever.
 *  - Edits are captured as an append-only history (`message_edits`): the prior
 *    version (text + its media blob) is snapshotted before the live row is
 *    overwritten, so the panel can show the full before/after trail.
 *  - Remote deletions are soft-deletes that KEEP the content and its stored
 *    media, so a deleted message is still fully viewable.
 *
 * Everything here is best-effort and idempotent: safe to call twice (webhook
 * retries), never duplicates bytes, and never throws into ingestion.
 */

import { query } from '../db'
import type { MediaType, MessageEdit } from '../types'
import { saveMediaFile, readMediaFile, deleteMediaFile } from '../media-store'

/** Largest media we copy into Postgres. Bigger files stay fetch-on-demand. */
export const MEDIA_MAX_STORE_BYTES = (() => {
  const raw = Number(process.env.MEDIA_MAX_STORE_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : 50 * 1024 * 1024
})()

/** Master switch — set MEDIA_ARCHIVE=0 to fall back to fetch-on-demand only. */
export const MEDIA_ARCHIVE_ENABLED = (process.env.MEDIA_ARCHIVE ?? '1') !== '0'

/**
 * Persist raw media bytes for a message and point the row at the stored blob.
 * Idempotent: if the message already has a blob we skip (a retry never
 * duplicates bytes). Returns the blob id, or null when nothing was stored.
 */
export async function storeMessageMediaBytes(
  messageId: string,
  bytes: Buffer,
  mime: string | null,
  name: string | null,
): Promise<string | null> {
  if (!MEDIA_ARCHIVE_ENABLED) return null
  if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_MAX_STORE_BYTES) {
    return null
  }

  const existing = await query<{ media_blob_id: string | null }>(
    `SELECT media_blob_id FROM messages WHERE id = $1`,
    [messageId],
  )
  if (existing.length === 0) return null
  if (existing[0].media_blob_id) return existing[0].media_blob_id

  // Bytes go to object storage / the local VPS filesystem (see
  // lib/media-store.ts for the tier ladder); only the locator lands in
  // Postgres. When every tier fails we fall back to bytea so the archive
  // guarantee still holds.
  let filePath: string | null = null
  try {
    filePath = await saveMediaFile(bytes, mime)
  } catch {
    filePath = null
  }

  let blob: Array<{ id: string }>
  try {
    blob = await query<{ id: string }>(
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
  if (blob.length === 0) {
    if (filePath) await deleteMediaFile(filePath)
    return null
  }
  await query(`UPDATE messages SET media_blob_id = $2 WHERE id = $1`, [
    messageId,
    blob[0].id,
  ])
  return blob[0].id
}

/** True when a message has media but no stored bytes yet. */
export async function messageNeedsMediaBytes(
  messageId: string,
): Promise<boolean> {
  const rows = await query<{
    media_type: string | null
    media_blob_id: string | null
  }>(`SELECT media_type, media_blob_id FROM messages WHERE id = $1`, [messageId])
  return rows.length > 0 && !!rows[0].media_type && !rows[0].media_blob_id
}

/**
 * Materialize a blob row into bytes: disk-backed rows (scripts/107) read from
 * the local filesystem, legacy rows still carry bytea inline.
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

/** Stored media bytes for a message's CURRENT version, or null. */
export async function getStoredMediaBytes(
  messageId: string,
): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  const rows = await query<{
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
  if (rows.length === 0) return null
  return resolveBlobBytes(rows[0])
}

/** Stored media bytes for a specific edit-history version, or null. */
export async function getStoredEditMediaBytes(
  editId: string,
): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  const rows = await query<{
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
  if (rows.length === 0) return null
  return resolveBlobBytes(rows[0])
}

/**
 * Record an edit to a message identified by channel + provider id. Snapshots
 * the current stored version into history, then overwrites the live row. No-op
 * when nothing changed. Returns the message id + whether media changed so the
 * caller can persist the new bytes.
 */
export async function recordMessageEditByProviderId(
  channelId: string,
  providerMessageId: string,
  next: {
    body: string
    mediaType?: MediaType | null
    mediaMime?: string | null
    mediaName?: string | null
  },
): Promise<{ messageId: string; mediaChanged: boolean } | null> {
  const rows = await query<{
    id: string
    body: string
    media_type: string | null
    media_mime: string | null
    media_name: string | null
    media_blob_id: string | null
    edit_count: number
  }>(
    `SELECT m.id, m.body, m.media_type, m.media_mime, m.media_name,
            m.media_blob_id, m.edit_count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1 AND m.provider_message_id = $2
      LIMIT 1`,
    [channelId, providerMessageId],
  )
  if (rows.length === 0) return null
  const row = rows[0]

  const nextType = next.mediaType ?? row.media_type
  const mediaChanged = (next.mediaType ?? null) !== (row.media_type ?? null)
  if (row.body === next.body && !mediaChanged) {
    return { messageId: row.id, mediaChanged: false }
  }

  const nextVersion = (row.edit_count ?? 0) + 1
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

/**
 * Full edit history for a message, oldest version first. Each entry is a prior
 * version snapshotted before it was overwritten; the message's live row holds
 * the current text. `mediaUrl` streams that version's archived media (if any).
 */
export async function getMessageEditHistory(
  messageId: string,
): Promise<MessageEdit[]> {
  const rows = await query<{
    id: string
    version: number
    body: string
    media_type: MediaType | null
    media_blob_id: string | null
    recorded_at: string | Date
  }>(
    `SELECT id, version, body, media_type, media_blob_id, recorded_at
       FROM message_edits
      WHERE message_id = $1
      ORDER BY version ASC`,
    [messageId],
  )
  return rows.map((r) => ({
    id: r.id,
    version: Number(r.version),
    body: r.body,
    ...(r.media_type ? { mediaType: r.media_type } : {}),
    ...(r.media_blob_id
      ? { mediaUrl: `/api/media/${messageId}?edit=${r.id}` }
      : {}),
    recordedAt: new Date(r.recorded_at).toISOString(),
  }))
}

/**
 * Soft-delete an inbound message the contact removed on their side, keeping its
 * text + stored media so it stays fully viewable. Returns the ids affected.
 */
export async function markInboundDeletedByProviderId(
  channelId: string,
  providerMessageId: string,
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `UPDATE messages m
        SET deleted_at = now(), deleted_origin = 'remote'
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND c.channel_id = $1
        AND m.provider_message_id = $2
        AND m.deleted_at IS NULL
      RETURNING m.id`,
    [channelId, providerMessageId],
  )
  return rows.map((r) => r.id)
}

/**
 * Housekeeping: удалить осиротевшие media_blobs — строки, на которые больше не
 * ссылается ни messages, ни message_edits, ни lead_card_attachments (все FK либо
 * SET NULL, либо CASCADE, так что после удаления родителя байты повисают
 * навсегда и копят гигабайты в БД).
 *
 * Осторожность: только блобы старше 24 часов (свежий блоб мог быть создан
 * мгновение назад и ещё не привязан к сообщению — гонка с ingest), батч с
 * LIMIT, чтобы не держать долгую блокировку. Вызывается piggyback'ом из
 * минутного крона dead-letters. Все проверяющие столбцы покрыты частичными
 * индексами (064, 077, 119), так что anti-join дешёвый.
 */
export async function cleanupOrphanedMediaBlobs(limit = 200): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM media_blobs mb
      WHERE mb.id IN (
        SELECT b.id FROM media_blobs b
         WHERE b.created_at < now() - interval '24 hours'
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.media_blob_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM message_edits e WHERE e.media_blob_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM lead_card_attachments la WHERE la.media_blob_id = b.id)
         LIMIT $1
      )
      RETURNING mb.id`,
    [limit],
  )
  return rows.length
}
