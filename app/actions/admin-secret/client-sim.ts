'use server'

import {
  randomUUID,
} from 'crypto'
import {
  revalidatePath,
} from 'next/cache'
import {
  requireAdmin,
} from '@/lib/auth'
import {
  query,
} from '@/lib/db'
import {
  MEDIA_ARCHIVE_ENABLED,
  MEDIA_MAX_STORE_BYTES,
  storeMessageMediaBytes,
} from '@/lib/data'
import {
  getThreadSimInfoOne,
  setThreadPaused,
} from '@/lib/client-sim/store'
import {
  type MediaType,
} from '@/lib/types'
import {
  ADMIN_PATH,
  audit,
  type ActionResult,
  type SendResult,
} from './shared'

/**
 * Write a message AS THE CLIENT (inbound). This is the core god-mode feature:
 * it simulates the contact writing in, so the owning manager sees it arrive in
 * their inbox in real time and can reply. Never writes as the manager.
 */
export async function secretSendAsClientAction(input: {
  conversationId: string
  body: string
}): Promise<SendResult> {
  await requireAdmin()
  const body = input.body?.trim()
  if (!input.conversationId || !body)
    return { ok: false, message: 'Выберите диалог и введите текст', createdMessage: null }

  const conv = await query<{ contact_name: string }>(
    'SELECT contact_name FROM conversations WHERE id = $1 LIMIT 1',
    [input.conversationId],
  )
  if (!conv[0])
    return { ok: false, message: 'Диалог не найден', createdMessage: null }

  const author = conv[0].contact_name || 'Клиент'
  const rows = await query<{ id: string; created_at: string | Date }>(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, 'in', $3, $4)
     RETURNING id, created_at`,
    [randomUUID(), input.conversationId, body, author],
  )
  await query(
    `UPDATE conversations
        SET last_message = $2, last_message_at = now(), unread = unread + 1
      WHERE id = $1`,
    [input.conversationId, body],
  )

  // Human takeover: if the simulator was actively driving this dialogue, detach
  // it from THIS conversation only (mirrors how a manager sending a real reply
  // pauses the AI on their side). Every other simulated thread keeps running.
  // Re-enable later via secretSetThreadSimAction — the engine then re-reads the
  // whole transcript, including these manual lines, and continues in persona.
  let simDetached = false
  const prevSim = await getThreadSimInfoOne(input.conversationId)
  if (prevSim?.active && !prevSim.paused) {
    simDetached = await setThreadPaused(input.conversationId, true)
  }

  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: simDetached
      ? 'Отправлено. Симулятор отключён от этого диалога'
      : 'Отправлено от имени клиента',
    simDetached,
    createdMessage: {
      id: rows[0].id,
      conversationId: input.conversationId,
      direction: 'in',
      body,
      author,
      createdAt: new Date(rows[0].created_at).toISOString(),
    },
  }
}

/**
 * Map an uploaded file's MIME to our `media_type` + the no-caption preview label
 * we synthesise. These MIRROR EXACTLY what a real inbound message on a channel
 * produces (see the WhatsApp/VK webhooks), so the owning manager can't tell a
 * god-injected attachment from one a real contact sent. All returned types are
 * within the messages.media_type CHECK constraint.
 */
function clientMediaKind(mime: string): {
  type: Extract<MediaType, 'image' | 'video' | 'audio' | 'document'>
  placeholder: string
} {
  if (mime.startsWith('image/')) return { type: 'image', placeholder: '[Фото]' }
  if (mime.startsWith('video/')) return { type: 'video', placeholder: '[Видео]' }
  if (mime.startsWith('audio/')) return { type: 'audio', placeholder: '[Аудио]' }
  return { type: 'document', placeholder: '[Документ]' }
}

/**
 * Write a media message AS THE CLIENT (inbound) — the file counterpart of
 * secretSendAsClientAction. The bytes are archived in Postgres (`media_blobs`)
 * and the message row points at them, so the owning manager's /api/media/{id}
 * proxy serves the file straight from the durable archive — byte-for-byte the
 * same delivery path as a real contact's photo/video/document, with no provider
 * round-trip and nothing that betrays it as simulated. Never writes as the
 * manager, and (like a real inbound) hands the thread back from the simulator.
 */
export async function secretSendClientMediaAction(
  conversationId: string,
  formData: FormData,
): Promise<SendResult> {
  await requireAdmin()

  const file = formData.get('file')
  const caption = ((formData.get('caption') as string | null) ?? '').trim()
  if (!conversationId || !(file instanceof File) || file.size === 0)
    return { ok: false, message: 'Выберите диалог и файл', createdMessage: null }

  // Durable archive is what makes the file viewable for the manager (there's no
  // provider to re-download from), so refuse up front when it's disabled rather
  // than inserting a message whose media would 404.
  if (!MEDIA_ARCHIVE_ENABLED)
    return {
      ok: false,
      message: 'Хранилище медиа отключено на сервере',
      createdMessage: null,
    }
  if (file.size > MEDIA_MAX_STORE_BYTES)
    return {
      ok: false,
      message: `Файл слишком большой (максимум ${Math.floor(
        MEDIA_MAX_STORE_BYTES / (1024 * 1024),
      )} МБ)`,
      createdMessage: null,
    }

  const conv = await query<{ contact_name: string }>(
    'SELECT contact_name FROM conversations WHERE id = $1 LIMIT 1',
    [conversationId],
  )
  if (!conv[0])
    return { ok: false, message: 'Диалог не найден', createdMessage: null }

  const mime = file.type || 'application/octet-stream'
  const kind = clientMediaKind(mime)
  // Optional delivery style for video: 'video_note' renders as a Telegram/VK-style
  // round "кружочек" on the manager side (same media_type real ingest uses). Any
  // non-video value or absence keeps the natural type from clientMediaKind.
  const sendAs = (formData.get('sendAs') as string | null) ?? ''
  const asVideoNote = sendAs === 'video_note' && kind.type === 'video'
  const mediaType: Extract<MediaType, 'image' | 'video' | 'video_note' | 'audio' | 'document'> =
    asVideoNote ? 'video_note' : kind.type
  const placeholder = asVideoNote ? '[Видеосообщение]' : kind.placeholder
  // Match real ingest exactly: photos/videos/audio (incl. video notes) arrive with
  // NO file name (providers don't send one), only documents carry their original
  // filename. Keeping this identical means a manager can't infer anything from a
  // stray name on an image or circle video.
  const name = mediaType === 'document' ? file.name || null : null
  // No-caption media uses the same bracketed placeholder real ingest does; the
  // manager UI hides it behind the media bubble. A caption shows as normal text.
  const body = caption || placeholder
  const author = conv[0].contact_name || 'Клиент'
  const bytes = Buffer.from(await file.arrayBuffer())

  const rows = await query<{ id: string; created_at: string | Date }>(
    `INSERT INTO messages
       (id, conversation_id, direction, body, author, media_type, media_mime, media_name)
     VALUES ($1, $2, 'in', $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [randomUUID(), conversationId, body, author, mediaType, mime, name],
  )
  const messageId = rows[0].id

  const storedBlobId = await storeMessageMediaBytes(messageId, bytes, mime, name)
  if (!storedBlobId) {
    // Couldn't persist the bytes — roll back the row so we never leave a message
    // whose attachment can't be opened.
    await query('DELETE FROM messages WHERE id = $1', [messageId])
    return { ok: false, message: 'Не удалось сохранить файл', createdMessage: null }
  }

  await query(
    `UPDATE conversations
        SET last_message = $2, last_message_at = now(), unread = unread + 1
      WHERE id = $1`,
    [conversationId, body],
  )

  // Human takeover: same as a manual text line — detach the simulator from THIS
  // dialogue only if it was actively driving it.
  let simDetached = false
  const prevSim = await getThreadSimInfoOne(conversationId)
  if (prevSim?.active && !prevSim.paused) {
    simDetached = await setThreadPaused(conversationId, true)
  }

  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: simDetached
      ? 'Файл отправлен. Симулятор отключён от этого диалога'
      : 'Файл отправлен от имени клиента',
    simDetached,
    createdMessage: {
      id: messageId,
      conversationId,
      direction: 'in',
      body,
      author,
      createdAt: new Date(rows[0].created_at).toISOString(),
      mediaType,
      mediaMime: mime,
      ...(name ? { mediaName: name } : {}),
      mediaUrl: `/api/media/${messageId}`,
    },
  }
}

/**
 * God-console control to detach / re-attach the simulator for ONE dialogue.
 *
 *   enabled = false → operator takes over: simulator stops driving this thread.
 *   enabled = true  → hand it back: on the next tick the engine re-reads the
 *                     full transcript (including the operator's manual client
 *                     lines) and continues in the same persona.
 *
 * Every other simulated dialogue is unaffected. No-op-safe on a pre-073 DB.
 */
export async function secretSetThreadSimAction(input: {
  conversationId: string
  enabled: boolean
}): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!input.conversationId) return { ok: false, message: 'Не указан диалог' }
  const changed = await setThreadPaused(input.conversationId, !input.enabled)
  if (!changed) {
    return {
      ok: false,
      message: 'Для этого диалога нет активного управления',
    }
  }
  audit(admin, input.enabled ? 'sim_thread_resume' : 'sim_thread_pause', {
    targetId: input.conversationId,
  })
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: input.enabled
      ? 'Симулятор снова ведёт диалог и учтёт ваши сообщения'
      : 'Вы управляете диалогом — симулятор отключён',
  }
}
