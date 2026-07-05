'use server'

import { revalidatePath } from 'next/cache'
import {
  comparePassword,
  hashPassword,
  requireManager,
  startSession,
} from '@/lib/auth'
import {
  addMessage,
  countAvailableManagers,
  enqueueJob,
  getConversation,
  getManagerAuthState,
  getManagerByEmail,
  getManagerOnLunch,
  getWhatsappCloudDispatchByConversationId,
  markConversationRead,
  markMessageFailed,
  setManagerOnLunch,
  setMessageProviderId,
  updateManagerPassword,
} from '@/lib/data'
import { deliverMaxMessage } from '@/lib/max-dispatch'
import { deliverVkMessage } from '@/lib/vk-dispatch'
import {
  deliverWhatsappMessage,
  markWhatsappConversationRead,
} from '@/lib/whatsapp-dispatch'
import {
  sendMedia,
  uploadMedia,
  type WaMediaKind,
} from '@/lib/whatsapp-cloud'
import type { MediaType, StickerItem } from '@/lib/types'

export interface SimpleResult {
  ok: boolean
  message: string
}

/**
 * Toggle the calling manager's "on lunch" availability. While on lunch, NEW
 * conversations are routed (round-robin) to other available managers; existing
 * conversations stay put. Returns the resulting state so the UI stays in sync.
 */
export async function setLunchAction(
  onLunch: boolean,
): Promise<{ ok: boolean; onLunch: boolean; message: string }> {
  const session = await requireManager()

  // Guard: at least one manager must always stay online. If this manager is the
  // last available one (active and not already on lunch), block going on lunch.
  if (onLunch) {
    const available = await countAvailableManagers()
    if (available <= 1) {
      return {
        ok: false,
        onLunch: false,
        message:
          'Вы сейчас единственный менеджер на линии. Дождитесь, пока вернётся кто-то ещё, прежде чем уходить на обед.',
      }
    }
  }

  try {
    await setManagerOnLunch(session.sub, onLunch)
  } catch (err) {
    console.error('[panel] setLunchAction failed:', err)
    return {
      ok: false,
      onLunch: !onLunch,
      message: 'Не удалось обновить статус.',
    }
  }
  // The inbox lists conversations for this manager; refresh after a change.
  revalidatePath('/app/inbox')
  return {
    ok: true,
    onLunch,
    message: onLunch
      ? 'Вы на обеде — новые диалоги уйдут другим менеджерам.'
      : 'Вы снова на линии.',
  }
}

/** Read the calling manager's current "on lunch" flag (for initial UI state). */
export async function getLunchStateAction(): Promise<boolean> {
  const session = await requireManager()
  return getManagerOnLunch(session.sub)
}

export async function changeOwnPasswordAction(
  formData: FormData,
): Promise<SimpleResult> {
  const session = await requireManager()
  const current = String(formData.get('current') ?? '')
  const next = String(formData.get('next') ?? '')

  if (next.length < 8) {
    return { ok: false, message: 'Новый пароль должен быть не короче 8 символов.' }
  }
  const manager = await getManagerByEmail(session.email)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }

  const ok = await comparePassword(current, manager.passwordHash)
  if (!ok) return { ok: false, message: 'Текущий пароль неверен.' }

  await updateManagerPassword(manager.id, await hashPassword(next))

  // updateManagerPassword bumps session_version, which would invalidate THIS
  // manager's own cookie. Re-issue the session with the fresh version so the
  // user who just changed their password stays signed in, while every other
  // outstanding session (e.g. on another device) is forced to re-authenticate.
  const fresh = await getManagerAuthState(manager.id)
  await startSession({
    sub: manager.id,
    role: 'manager',
    email: manager.email,
    name: manager.name,
    sv: fresh?.sessionVersion ?? 0,
  })

  return { ok: true, message: 'Пароль обновлён.' }
}

export async function sendMessageAction(
  conversationId: string,
  body: string,
): Promise<SimpleResult> {
  const session = await requireManager()
  const text = body.trim()
  if (!text) return { ok: false, message: 'Сообщение пустое.' }

  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: text,
    author: session.name,
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  // Delivery routing by channel:
  //  • Telegram (+ legacy Baileys WhatsApp): worker job queue.
  //  • WhatsApp Cloud API: direct Graph API call (no worker/session).
  //  • MAX: direct Bot API call.
  //  • Live chat: no delivery — the inserted 'out' row fires a realtime NOTIFY
  //    that the website widget receives over its SSE stream.
  const conv = await getConversation(conversationId, session.sub)
  if (conv && conv.channelType === 'whatsapp') {
    // Cloud API handles delivery itself; only fall back to the worker for any
    // remaining legacy Baileys channel.
    const handled = await deliverWhatsappMessage(conversationId, msg.id, text)
    if (!handled) {
      await enqueueJob({
        channelId: conv.channelId,
        managerId: session.sub,
        action: 'send_message',
        payload: { target: conv.contactHandle, body: text, messageId: msg.id },
      }).catch((err) => {
        console.error('[panel] failed to enqueue send_message job:', err)
      })
    }
  } else if (conv && conv.channelType === 'telegram') {
    await enqueueJob({
      channelId: conv.channelId,
      managerId: session.sub,
      action: 'send_message',
      // Pass the optimistic row id so the worker can backfill the provider
      // message id and attach delivery/read receipts — and flag the row
      // 'failed' if the send is rejected.
      payload: { target: conv.contactHandle, body: text, messageId: msg.id },
    }).catch((err) => {
      console.error('[panel] failed to enqueue send_message job:', err)
    })
  } else if (conv && conv.channelType === 'max') {
    // Push straight to MAX and backfill the provider id (or flag failed).
    await deliverMaxMessage(conversationId, msg.id, text)
  } else if (conv && conv.channelType === 'vk') {
    // Push straight to VK and backfill the provider id (or flag failed).
    await deliverVkMessage(conversationId, msg.id, text)
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Отправлено.' }
}

/**
 * Mark a conversation as read: clears our unread counter and, for
 * Telegram/WhatsApp, tells the worker to send read receipts so the contact sees
 * our messages were read. Best-effort and safe to call repeatedly (e.g. each
 * time the operator opens a chat).
 */
export async function markConversationReadAction(
  conversationId: string,
): Promise<SimpleResult> {
  const session = await requireManager()

  const conv = await markConversationRead(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }

  if (conv.channelType === 'whatsapp') {
    // Cloud API sends the read receipt directly; fall back to the worker only
    // for legacy Baileys channels.
    const handled = await markWhatsappConversationRead(conversationId)
    if (!handled) {
      await enqueueJob({
        channelId: conv.channelId,
        managerId: session.sub,
        action: 'mark_read',
        payload: { target: conv.contactHandle },
      }).catch((err) => {
        console.error('[panel] failed to enqueue mark_read job:', err)
      })
    }
  } else if (conv.channelType === 'telegram') {
    await enqueueJob({
      channelId: conv.channelId,
      managerId: session.sub,
      action: 'mark_read',
      payload: { target: conv.contactHandle },
    }).catch((err) => {
      console.error('[panel] failed to enqueue mark_read job:', err)
    })
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Прочитано.' }
}

/**
 * Per-kind upload size caps (Cloud API limits). Documents allow the most;
 * images/audio/video are smaller. Stickers must be tiny WebP.
 */
const WA_MEDIA_LIMITS: Record<WaMediaKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  sticker: 100 * 1024,
}

const MEDIA_KIND_LABEL: Record<MediaType, string> = {
  image: '[Фото]',
  video: '[Видео]',
  video_note: '[Видео]',
  audio: '[Аудио]',
  voice: '[Голосовое сообщение]',
  sticker: '[Стикер]',
  document: '[Документ]',
}

/**
 * Decide how to classify an upload by its MIME type. Returns the Cloud API
 * media kind (how we send it) plus our internal MediaType (how the panel renders
 * it). Anything unrecognised is treated as a document.
 */
function classifyUpload(mime: string): { kind: WaMediaKind; mediaType: MediaType } {
  if (mime.startsWith('image/')) {
    return mime === 'image/webp'
      ? { kind: 'sticker', mediaType: 'sticker' }
      : { kind: 'image', mediaType: 'image' }
  }
  if (mime.startsWith('video/')) return { kind: 'video', mediaType: 'video' }
  if (mime.startsWith('audio/')) return { kind: 'audio', mediaType: 'audio' }
  return { kind: 'document', mediaType: 'document' }
}

/**
 * Send a media file on a WhatsApp Cloud conversation. The browser posts the file
 * via FormData; we upload the bytes to the Graph API, send the media message,
 * and record an outbound row (with a `waMediaId` so the panel can re-display it
 * through /api/media). Delivery ticks are backfilled by the status webhook; a
 * rejected send is flagged 'failed'. Only inside the 24h service window.
 */
export async function sendWhatsappMediaAction(
  conversationId: string,
  formData: FormData,
): Promise<SimpleResult> {
  const session = await requireManager()

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Файл не выбран.' }
  }
  const caption = String(formData.get('caption') ?? '').trim()

  const conv = await getConversation(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'whatsapp') {
    return { ok: false, message: 'Вложения доступны только для WhatsApp.' }
  }

  const mime = file.type || 'application/octet-stream'
  const { kind, mediaType } = classifyUpload(mime)
  if (file.size > WA_MEDIA_LIMITS[kind]) {
    const mb = Math.round(WA_MEDIA_LIMITS[kind] / (1024 * 1024))
    return { ok: false, message: `Файл слишком большой (максимум ${mb} МБ).` }
  }

  const dispatch = await getWhatsappCloudDispatchByConversationId(conversationId)
  if (!dispatch) {
    return { ok: false, message: 'WhatsApp не настроен — добавьте токен в админке.' }
  }

  // 1) Upload the bytes to WhatsApp → media id.
  const up = await uploadMedia(
    dispatch.phoneNumberId,
    dispatch.token,
    file,
    mime,
    file.name || 'file',
  )
  if (!up.ok) {
    console.error('[panel] whatsapp media upload failed:', up.error)
    return { ok: false, message: 'Не удалось загрузить файл в WhatsApp.' }
  }

  // 2) Record the outbound row immediately so it shows in the thread.
  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: caption,
    preview: caption || MEDIA_KIND_LABEL[mediaType],
    author: session.name,
    mediaType,
    mediaMime: mime,
    mediaName: kind === 'document' ? file.name || undefined : undefined,
    mediaRef: { waMediaId: up.data.id },
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  // 3) Send the media message; backfill the provider id or flag failed.
  const sent = await sendMedia(
    dispatch.phoneNumberId,
    dispatch.token,
    dispatch.contactHandle,
    kind,
    up.data.id,
    caption || undefined,
    file.name || undefined,
  )
  if (!sent.ok) {
    console.error('[panel] whatsapp media send failed:', sent.error)
    await markMessageFailed(msg.id).catch(() => {})
    revalidatePath('/app/inbox')
    return {
      ok: false,
      message:
        sent.status === 470 || /window/i.test(sent.error)
          ? 'Окно 24 часов закрыто — клиент должен написать первым.'
          : 'Файл сохранён, но WhatsApp отклонил отправку.',
    }
  }
  const mid = sent.data.messages?.[0]?.id
  if (mid) await setMessageProviderId(msg.id, mid).catch(() => {})

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Файл отправлен.' }
}

/**
 * Send a sticker (Telegram only). Records an outgoing 'sticker' message for
 * instant display, then enqueues a send_sticker job for the worker to deliver
 * via MTProto.
 */
export async function sendStickerAction(
  conversationId: string,
  sticker: StickerItem,
): Promise<SimpleResult> {
  const session = await requireManager()
  if (!sticker || !sticker.id || !sticker.accessHash || !sticker.fileReference) {
    return { ok: false, message: 'Не��орректный стикер.' }
  }

  const conv = await getConversation(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'telegram') {
    return { ok: false, message: 'Стикеры доступны только для Telegram.' }
  }

  // Record the outgoing sticker so it appears immediately in the thread. The
  // body carries the emoji (or a placeholder) for previews / accessibility.
  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: sticker.emoji || '[Стикер]',
    author: session.name,
    mediaType: 'sticker',
    mediaMime: sticker.mime || 'image/webp',
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  await enqueueJob({
    channelId: conv.channelId,
    managerId: session.sub,
    action: 'send_sticker',
    payload: {
      target: conv.contactHandle,
      documentId: sticker.id,
      accessHash: sticker.accessHash,
      fileReference: sticker.fileReference,
      emoji: sticker.emoji,
    },
  }).catch((err) => {
    console.error('[panel] failed to enqueue send_sticker job:', err)
  })

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Стикер отпр��влен.' }
}
