'use server'

import {
  randomUUID,
} from 'crypto'
import {
  query,
  withTransaction,
} from '@/lib/db'
import {
  MEDIA_MAX_STORE_BYTES,
} from '@/lib/data/media-archive'
import { saveMediaFile } from '@/lib/media-store'
import {
  assertConsoleOrMessenger,
  type ActionResult,
} from './shared'

/**
 * Conversation actions backing the god messenger (`/wijegniwjgwjog/messages`).
 *
 * All of them funnel through the shared parameterised `query` helper (no string
 * interpolation into SQL) and go through the same tables/triggers as a real
 * chat, so everything lands live in the owning manager's inbox.
 *
 * NOTE: none of these call `revalidatePath`. The messenger is a fully client-
 * driven surface fed by the admin SSE stream; revalidating the route from a
 * server action forces a router refresh that can remount the client component
 * and kick the user out of the open thread mid-conversation.
 */

export interface CreateConversationResult extends ActionResult {
  /** Id of the created conversation so the caller can open it immediately. */
  id?: string
}

export async function secretCreateConversationAction(input: {
  channelId: string
  contactName: string
  contactHandle: string
  message?: string
  /**
   * Optional backdated creation time (ISO string) — used by the scenario
   * picker so a "client" thread can appear as if it started earlier. Applied
   * to BOTH the conversation's last_message_at and the first message's
   * created_at so list ordering and the thread timeline stay consistent.
   * Clamped server-side: never in the future, never older than 2 years.
   */
  createdAt?: string
}): Promise<CreateConversationResult> {
  await assertConsoleOrMessenger()

  const contactName = input.contactName?.trim()
  const contactHandle = input.contactHandle?.trim()
  if (!input.channelId || !contactName || !contactHandle)
    return { ok: false, message: 'Заполните канал, имя и хэндл контакта' }

  // Validate/clamp the optional backdate BEFORE touching the DB.
  let createdAt: Date | null = null
  if (input.createdAt) {
    const d = new Date(input.createdAt)
    if (Number.isNaN(d.getTime()))
      return { ok: false, message: 'Некорректное время создания диалога' }
    const now = Date.now()
    const oldest = now - 2 * 365 * 24 * 60 * 60 * 1000
    createdAt = new Date(Math.min(Math.max(d.getTime(), oldest), now))
  }

  const channel = await query<{ id: string; type: string; manager_id: string | null }>(
    'SELECT id, type, manager_id FROM channels WHERE id = $1 LIMIT 1',
    [input.channelId],
  )
  if (!channel[0]) return { ok: false, message: 'Канал не найден' }
  if (!channel[0].manager_id)
    return {
      ok: false,
      message: 'У канала нет владельца — назначьте менеджера перед созданием диалога',
    }

  const id = randomUUID()
  const firstMessage = input.message?.trim() ?? ''

  // Conversation + first message are one atomic unit: a crash between the two
  // inserts must never leave a thread whose preview references a lost message.
  await withTransaction(async (db) => {
    await db.query(
      `INSERT INTO conversations
         (id, channel_id, channel_type, manager_id, contact_name, contact_handle, last_message, last_message_at, status, unread)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($9::timestamptz, now()), 'liquid', $8)`,
      [
        id,
        channel[0].id,
        channel[0].type,
        channel[0].manager_id,
        contactName,
        contactHandle,
        firstMessage,
        firstMessage ? 1 : 0,
        createdAt ? createdAt.toISOString() : null,
      ],
    )
    if (firstMessage) {
      await db.query(
        `INSERT INTO messages (id, conversation_id, direction, body, author, created_at)
         VALUES ($1, $2, 'in', $3, $4, COALESCE($5::timestamptz, now()))`,
        [
          randomUUID(),
          id,
          firstMessage,
          contactName,
          createdAt ? createdAt.toISOString() : null,
        ],
      )
    }
  })

  return { ok: true, message: `Диалог с «${contactName}» создан`, id }
}

export interface SendMessageResult extends ActionResult {
  /** The persisted message id — lets the client append optimistically. */
  id?: string
  createdAt?: string
}

export async function secretSendMessageAction(input: {
  conversationId: string
  body: string
  direction: string
  /** Optional quoted-reply target (Telegram-style). */
  replyToMessageId?: string
}): Promise<SendMessageResult> {
  await assertConsoleOrMessenger()

  const body = input.body?.trim()
  const direction = input.direction === 'in' ? 'in' : 'out'
  if (!input.conversationId || !body)
    return { ok: false, message: 'Выберите диалог и введите текст' }

  const conv = await query<{ contact_name: string }>(
    'SELECT contact_name FROM conversations WHERE id = $1 LIMIT 1',
    [input.conversationId],
  )
  if (!conv[0]) return { ok: false, message: 'Диалог не найден' }

  const author = direction === 'out' ? 'Менеджер' : conv[0].contact_name || 'Клиент'
  const messageId = randomUUID()

  // Validate the quoted target belongs to the SAME conversation before linking.
  let replyTo: string | null = null
  if (input.replyToMessageId) {
    const target = await query<{ id: string }>(
      'SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 LIMIT 1',
      [input.replyToMessageId, input.conversationId],
    )
    replyTo = target[0]?.id ?? null
  }

  // Message insert + conversation preview update are atomic so the list and
  // the thread can never drift apart.
  const created = await withTransaction(async (db) => {
    const rows = await db.query<{ created_at: string | Date }>(
      `INSERT INTO messages (id, conversation_id, direction, body, author, reply_to_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING created_at`,
      [messageId, input.conversationId, direction, body, author, replyTo],
    )
    await db.query(
      `UPDATE conversations
          SET last_message = $2,
              last_message_at = now(),
              unread = unread + CASE WHEN $3 = 'in' THEN 1 ELSE 0 END
        WHERE id = $1`,
      [input.conversationId, body, direction],
    )
    return rows[0]
  })

  return {
    ok: true,
    message: 'Сообщение добавлено в диалог',
    id: messageId,
    createdAt: new Date(created.created_at).toISOString(),
  }
}

/**
 * Edit a message "as the client" (or manager), Telegram-style. The previous
 * version is snapshotted into the append-only `message_edits` history before
 * the live row is overwritten, so the manager inbox can show the full
 * "изменено" trail. If the edited message is the newest one, the conversation
 * preview is refreshed too. All in one transaction.
 */
export async function secretEditMessageAction(input: {
  messageId: string
  conversationId: string
  body: string
}): Promise<ActionResult> {
  await assertConsoleOrMessenger()

  const body = input.body?.trim()
  if (!input.messageId || !input.conversationId || !body)
    return { ok: false, message: 'Текст сообщения не может быть пустым' }

  const rows = await query<{
    id: string
    body: string
    media_type: string | null
    media_mime: string | null
    media_name: string | null
    media_blob_id: string | null
    edit_count: number
    deleted_at: string | null
  }>(
    `SELECT id, body, media_type, media_mime, media_name, media_blob_id, edit_count, deleted_at
       FROM messages
      WHERE id = $1 AND conversation_id = $2
      LIMIT 1`,
    [input.messageId, input.conversationId],
  )
  if (!rows[0]) return { ok: false, message: 'Сообщение не найдено' }
  if (rows[0].deleted_at) return { ok: false, message: 'Сообщение удалено' }
  if (rows[0].body === body) return { ok: true, message: 'Без изменений' }

  const prev = rows[0]
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
          SET last_message = $3
        WHERE c.id = $1
          AND (SELECT m.id FROM messages m
                WHERE m.conversation_id = $1
                ORDER BY m.created_at DESC LIMIT 1) = $2`,
      [input.conversationId, input.messageId, body],
    )
  })

  return { ok: true, message: 'Сообщение изменено' }
}

/**
 * Soft-delete a message from the messenger (Telegram-style «Удалить»). Uses
 * `deleted_at` so the manager inbox shows the standard "message deleted"
 * placeholder and reply references stay intact. Also re-syncs the conversation
 * preview and, when an unread inbound message is removed, the unread counter.
 */
export async function secretMessengerDeleteMessageAction(input: {
  messageId: string
  conversationId: string
}): Promise<ActionResult> {
  await assertConsoleOrMessenger()
  if (!input.messageId || !input.conversationId)
    return { ok: false, message: 'Не указано сообщение' }

  await withTransaction(async (db) => {
    const del = await db.query<{ id: string; direction: 'in' | 'out' }>(
      `UPDATE messages
          SET deleted_at = now(), deleted_origin = 'remote'
        WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL
        RETURNING id, direction`,
      [input.messageId, input.conversationId],
    )
    if (!del[0]) return

    // Preview = newest NON-deleted message. Unread — точный пересчёт из
    // состояния сообщений (см. 125_message_read_at.sql): удаление уже
    // прочитанного входящего больше не занижает счётчик, как слепой декремент.
    await db.query(
      `UPDATE conversations c
          SET last_message = COALESCE(
                (SELECT m.body FROM messages m
                  WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
                  ORDER BY m.created_at DESC LIMIT 1),
                ''
              ),
              unread = (
                SELECT COUNT(*)::int FROM messages m
                 WHERE m.conversation_id = $1
                   AND m.direction = 'in'
                   AND m.read_at IS NULL
                   AND m.deleted_at IS NULL
              )
        WHERE c.id = $1`,
      [input.conversationId],
    )
  })

  return { ok: true, message: 'Сообщение удалено' }
}

/** Media kinds the messenger composer can upload. */
const MEDIA_KIND_BY_PREFIX: Array<[string, string]> = [
  ['image/', 'image'],
  ['video/', 'video'],
  ['audio/', 'audio'],
]

/** Practical upload ceiling (also re-checked against the archive limit). */
const UPLOAD_MAX_BYTES = Math.min(25 * 1024 * 1024, MEDIA_MAX_STORE_BYTES)

/**
 * Send a media message (photo / video / voice note / audio / document) "as the
 * client". The bytes are archived in `media_blobs` (same durable store the real
 * ingestion uses) and the message row carries the standard media descriptor, so
 * the manager inbox renders it exactly like genuine incoming media.
 *
 * Accepts FormData: file, conversationId, direction ('in'|'out'), optional
 * caption, optional kind override ('voice' for recorded voice notes).
 */
export async function secretSendMediaMessageAction(
  formData: FormData,
): Promise<SendMessageResult> {
  await assertConsoleOrMessenger()

  const file = formData.get('file')
  const conversationId = String(formData.get('conversationId') ?? '')
  const direction = formData.get('direction') === 'out' ? 'out' : 'in'
  const caption = String(formData.get('caption') ?? '').trim()
  const kindOverride = String(formData.get('kind') ?? '')

  if (!(file instanceof File) || !conversationId)
    return { ok: false, message: 'Выберите диалог и файл' }
  if (file.size === 0) return { ok: false, message: 'Файл пустой' }
  if (file.size > UPLOAD_MAX_BYTES)
    return {
      ok: false,
      message: `Файл слишком большой (макс. ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)} МБ)`,
    }

  const conv = await query<{ contact_name: string }>(
    'SELECT contact_name FROM conversations WHERE id = $1 LIMIT 1',
    [conversationId],
  )
  if (!conv[0]) return { ok: false, message: 'Диалог не найден' }

  const mime = file.type || 'application/octet-stream'
  let mediaType = 'document'
  if (kindOverride === 'voice' && mime.startsWith('audio/')) {
    mediaType = 'voice'
  } else {
    for (const [prefix, kind] of MEDIA_KIND_BY_PREFIX) {
      if (mime.startsWith(prefix)) {
        mediaType = kind
        break
      }
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const author = direction === 'out' ? 'Менеджер' : conv[0].contact_name || 'Клиент'
  const messageId = randomUUID()
  const body = caption || mediaBodyLabel(mediaType, file.name)

  // Bytes go to S3 / the local VPS filesystem (see lib/media-store.ts); bytea
  // only as a fallback when every tier fails, so uploads keep working either way.
  let uploadFilePath: string | null = null
  try {
    uploadFilePath = await saveMediaFile(bytes, mime)
  } catch {
    uploadFilePath = null
  }

  const created = await withTransaction(async (db) => {
    const blob = await db.query<{ id: string }>(
      `INSERT INTO media_blobs (bytes, mime, name, byte_size, file_path)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        uploadFilePath ? null : bytes,
        mime,
        file.name || null,
        bytes.byteLength,
        uploadFilePath,
      ],
    )
    const rows = await db.query<{ created_at: string | Date }>(
      `INSERT INTO messages
         (id, conversation_id, direction, body, author, media_type, media_mime, media_name, media_blob_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING created_at`,
      [
        messageId,
        conversationId,
        direction,
        body,
        author,
        mediaType,
        mime,
        file.name || null,
        blob[0].id,
      ],
    )
    await db.query(
      `UPDATE conversations
          SET last_message = $2,
              last_message_at = now(),
              unread = unread + CASE WHEN $3 = 'in' THEN 1 ELSE 0 END
        WHERE id = $1`,
      [conversationId, body, direction],
    )
    return rows[0]
  })

  return {
    ok: true,
    message: 'Отправлено',
    id: messageId,
    createdAt: new Date(created.created_at).toISOString(),
  }
}

/** Human preview text when a media message has no caption. */
function mediaBodyLabel(mediaType: string, name: string): string {
  switch (mediaType) {
    case 'image':
      return '[Фото]'
    case 'video':
      return '[Видео]'
    case 'voice':
      return '[Голосовое сообщение]'
    case 'audio':
      return '[Аудио]'
    default:
      return name ? `[Файл] ${name}` : '[Файл]'
  }
}
