/**
 * Вложения карточки лида (scripts/119): фото/видео, загруженные менеджером
 * или менеджером по кадрам, и телеграм-«кружки» (video_note), прикреплённые из реального
 * диалога. Байты живут в media_blobs (диск VPS / bytea) — как у сообщений.
 */

import { query } from '../db'
import { saveMediaFile, deleteMediaFile, readMediaFile } from '../media-store'

export type LeadAttachmentKind = 'photo' | 'video' | 'video_note'

export interface LeadAttachment {
  id: string
  leadCardId: string
  authorId: string
  authorName: string | null
  authorRole: 'manager' | 'curator' | 'admin' | null
  kind: LeadAttachmentKind
  /** Кружок ссылается на сообщение диалога, загруженный файл — нет. */
  messageId: string | null
  fileName: string | null
  mime: string | null
  byteSize: number | null
  createdAt: string
  /** Стриминговый URL — /api/lead-media/<id>. */
  url: string
}

interface AttachmentRow {
  id: string
  lead_card_id: string
  author_id: string
  author_name: string | null
  author_role: string | null
  kind: LeadAttachmentKind
  message_id: string | null
  file_name: string | null
  mime: string | null
  byte_size: string | number | null
  created_at: string | Date
}

function toAttachment(r: AttachmentRow): LeadAttachment {
  const role =
    r.author_role === 'manager' ||
    r.author_role === 'curator' ||
    r.author_role === 'admin'
      ? r.author_role
      : null
  return {
    id: r.id,
    leadCardId: r.lead_card_id,
    authorId: r.author_id,
    authorName: r.author_name,
    authorRole: role,
    kind: r.kind,
    messageId: r.message_id,
    fileName: r.file_name,
    mime: r.mime,
    byteSize: r.byte_size == null ? null : Number(r.byte_size),
    createdAt: new Date(r.created_at).toISOString(),
    url: `/api/lead-media/${r.id}`,
  }
}

const ATTACHMENT_SELECT = `
  a.id, a.lead_card_id, a.author_id, a.kind, a.message_id,
  a.file_name, a.mime, a.byte_size, a.created_at,
  m.name AS author_name, m.role AS author_role`

/** Все вложения карточки, новые сверху. */
export async function listLeadAttachments(
  leadCardId: string,
): Promise<LeadAttachment[]> {
  const rows = await query<AttachmentRow>(
    `SELECT ${ATTACHMENT_SELECT}
       FROM lead_card_attachments a
       LEFT JOIN managers m ON m.id = a.author_id
      WHERE a.lead_card_id = $1
      ORDER BY a.created_at DESC`,
    [leadCardId],
  )
  return rows.map(toAttachment)
}

/** Сохранить загруженный файл: байты → media_blobs → строка вложения. */
export async function addLeadFileAttachment(input: {
  leadCardId: string
  authorId: string
  kind: 'photo' | 'video'
  bytes: Buffer
  mime: string
  fileName: string | null
}): Promise<LeadAttachment> {
  // S3/диск — основной носитель (см. lib/media-store.ts); при сбое всех
  // ярусов байты падают в bytea — тот же контракт, что у storeMessageMediaBytes.
  let filePath: string | null = null
  try {
    filePath = await saveMediaFile(input.bytes, input.mime)
  } catch {
    filePath = null
  }

  let blobId: string
  try {
    const blob = await query<{ id: string }>(
      `INSERT INTO media_blobs (bytes, mime, name, byte_size, file_path)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        filePath ? null : input.bytes,
        input.mime,
        input.fileName,
        input.bytes.byteLength,
        filePath,
      ],
    )
    blobId = blob[0].id
  } catch (err) {
    if (filePath) await deleteMediaFile(filePath)
    throw err
  }

  const rows = await query<{ id: string }>(
    `INSERT INTO lead_card_attachments
       (lead_card_id, author_id, kind, media_blob_id, file_name, mime, byte_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.leadCardId,
      input.authorId,
      input.kind,
      blobId,
      input.fileName,
      input.mime,
      input.bytes.byteLength,
    ],
  )
  const attached = await getLeadAttachmentById(rows[0].id)
  if (!attached) throw new Error('Attachment insert failed')
  return attached
}

/**
 * Прикрепить кружок или фото из диалога. Проверяет, что сообщение
 * действительно принадлежит ЭТОМУ диалогу и имеет подходящий тип медиа.
 * Идемпотентно (уникальный индекс).
 */
export async function addLeadVideoNoteAttachment(input: {
  leadCardId: string
  conversationId: string
  messageId: string
  authorId: string
  /** 'video_note' (по умолчанию) или 'photo' — фото из переписки. */
  kind?: 'video_note' | 'photo'
}): Promise<LeadAttachment | null> {
  const kind = input.kind ?? 'video_note'
  // Легаси-кружки могли попасть в архив как voice/audio с video/* MIME.
  const typeCondition =
    kind === 'photo'
      ? `media_type = 'image'`
      : `(media_type = 'video_note'
          OR (media_type IN ('voice', 'audio') AND media_mime LIKE 'video/%'))`
  const msg = await query<{ id: string; media_mime: string | null }>(
    `SELECT id, media_mime FROM messages
      WHERE id = $1 AND conversation_id = $2 AND ${typeCondition}
      LIMIT 1`,
    [input.messageId, input.conversationId],
  )
  if (!msg[0]) return null

  const rows = await query<{ id: string }>(
    `INSERT INTO lead_card_attachments
       (lead_card_id, author_id, kind, message_id, mime)
     VALUES ($1, $2, $5, $3, $4)
     ON CONFLICT (lead_card_id, message_id) WHERE message_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [input.leadCardId, input.authorId, input.messageId, msg[0].media_mime, kind],
  )
  if (!rows[0]) {
    // Уже прикреплён — вернуть существующий.
    const existing = await query<AttachmentRow>(
      `SELECT ${ATTACHMENT_SELECT}
         FROM lead_card_attachments a
         LEFT JOIN managers m ON m.id = a.author_id
        WHERE a.lead_card_id = $1 AND a.message_id = $2
        LIMIT 1`,
      [input.leadCardId, input.messageId],
    )
    return existing[0] ? toAttachment(existing[0]) : null
  }
  return getLeadAttachmentById(rows[0].id)
}

export async function getLeadAttachmentById(
  id: string,
): Promise<LeadAttachment | null> {
  const rows = await query<AttachmentRow>(
    `SELECT ${ATTACHMENT_SELECT}
       FROM lead_card_attachments a
       LEFT JOIN managers m ON m.id = a.author_id
      WHERE a.id = $1
      LIMIT 1`,
    [id],
  )
  return rows[0] ? toAttachment(rows[0]) : null
}

/** Удалить вложение (файл на диске подчищается, если blob больше никем не занят). */
export async function deleteLeadAttachment(id: string): Promise<void> {
  const rows = await query<{ media_blob_id: string | null }>(
    `DELETE FROM lead_card_attachments WHERE id = $1
     RETURNING media_blob_id`,
    [id],
  )
  const blobId = rows[0]?.media_blob_id
  if (!blobId) return
  // Блоб принадлежит только вложению (сообщения держат свои блобы отдельно) —
  // но проверяем обе таблицы, прежде чем трогать байты.
  const used = await query<{ n: string }>(
    `SELECT (SELECT count(*) FROM lead_card_attachments WHERE media_blob_id = $1)
          + (SELECT count(*) FROM messages WHERE media_blob_id = $1)
          + (SELECT count(*) FROM message_edits WHERE media_blob_id = $1) AS n`,
    [blobId],
  )
  if (Number(used[0]?.n ?? 0) > 0) return
  const blob = await query<{ file_path: string | null }>(
    `DELETE FROM media_blobs WHERE id = $1 RETURNING file_path`,
    [blobId],
  )
  if (blob[0]?.file_path) await deleteMediaFile(blob[0].file_path)
}

/** Байты вложения-файла (для стриминга). Кружки идут через message_id. */
export async function getLeadAttachmentBytes(
  id: string,
): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  const rows = await query<{
    bytes: Buffer | null
    file_path: string | null
    mime: string | null
    name: string | null
  }>(
    `SELECT b.bytes, b.file_path, b.mime, b.name
       FROM lead_card_attachments a
       JOIN media_blobs b ON b.id = a.media_blob_id
      WHERE a.id = $1`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  if (row.file_path) {
    const fromDisk = await readMediaFile(row.file_path)
    if (fromDisk) return { bytes: fromDisk, mime: row.mime, name: row.name }
  }
  if (row.bytes) {
    return { bytes: Buffer.from(row.bytes), mime: row.mime, name: row.name }
  }
  return null
}

export interface ConversationVideoNote {
  messageId: string
  createdAt: string
  direction: 'in' | 'out'
  /** Порядковый номер кружка в диалоге (1 — самый первый). */
  ordinal: number
}

/**
 * Все кружки диалога по порядку появления.
 *
 * ВАЖНО: кружки, попавшие в архив до поддержки video_note, лежат в БД как
 * voice/audio с video/* MIME (та же эвристика, что effectiveMediaType в
 * message-media.tsx). Без второго условия менеджер видел кружки в переписке,
 * а кнопка «Кружок» отвечала «в диалоге нет кружков».
 */
export async function listConversationVideoNotes(
  conversationId: string,
): Promise<ConversationVideoNote[]> {
  const rows = await query<{
    id: string
    created_at: string | Date
    direction: 'in' | 'out'
  }>(
    `SELECT id, created_at, direction
       FROM messages
      WHERE conversation_id = $1
        AND (
          media_type = 'video_note'
          OR (media_type IN ('voice', 'audio') AND media_mime LIKE 'video/%')
        )
        AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [conversationId],
  )
  return rows.map((r, i) => ({
    messageId: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    direction: r.direction,
    ordinal: i + 1,
  }))
}

/** Все фотографии диалога по порядку появления (кнопка «Документ»). */
export async function listConversationPhotos(
  conversationId: string,
): Promise<ConversationVideoNote[]> {
  const rows = await query<{
    id: string
    created_at: string | Date
    direction: 'in' | 'out'
  }>(
    `SELECT id, created_at, direction
       FROM messages
      WHERE conversation_id = $1
        AND media_type = 'image'
        AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [conversationId],
  )
  return rows.map((r, i) => ({
    messageId: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    direction: r.direction,
    ordinal: i + 1,
  }))
}
