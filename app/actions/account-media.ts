'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  addMessage,
  enqueueJob,
  getConversation,
  getVkDispatchByConversationId,
  getWhatsappCloudDispatchByConversationId,
  markMessageFailed,
  setMessageProviderId,
} from '@/lib/data'
import {
  sendMessage as sendVkMessage,
  uploadDocAttachment as uploadVkDoc,
  uploadPhotoAttachment as uploadVkPhoto,
} from '@/lib/vk'
import {
  sendMedia,
  uploadMedia,
  type WaMediaKind,
} from '@/lib/whatsapp-cloud'
import type { MediaType } from '@/lib/types'
import type { SimpleResult } from './account-shared'

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
    dispatch.proxy,
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
    dispatch.proxy,
  )
  if (!sent.ok) {
    console.error('[panel] whatsapp media send failed:', sent.error)
    await markMessageFailed(msg.id, sent.error).catch(() => {})
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
 * Per-kind upload size caps for VK. VK allows large docs; we keep sane limits so
 * a huge upload can't tie up the account's proxy.
 */
const VK_MEDIA_LIMITS = {
  photo: 25 * 1024 * 1024,
  doc: 200 * 1024 * 1024,
}

/**
 * Send a media file on a VK conversation. Static images (except GIFs) upload as
 * a VK photo; everything else uploads as a VK document. The bytes are uploaded
 * through the account's proxy, an outbound row is recorded for instant display
 * (with the returned CDN url in media_ref), then messages.send delivers it —
 * backfilling the provider id or flagging the row 'failed' with VK's reason.
 */
export async function sendVkMediaAction(
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
  if (conv.channelType !== 'vk') {
    return { ok: false, message: 'Это действие доступно только для VK.' }
  }

  const mime = file.type || 'application/octet-stream'
  // VK photo upload only accepts static raster images; GIFs and everything else
  // must go through the document uploader.
  const asPhoto = mime.startsWith('image/') && mime !== 'image/gif'
  const cap = asPhoto ? VK_MEDIA_LIMITS.photo : VK_MEDIA_LIMITS.doc
  if (file.size > cap) {
    const mb = Math.round(cap / (1024 * 1024))
    return { ok: false, message: `Файл слишком большой (максимум ${mb} МБ).` }
  }

  const dispatch = await getVkDispatchByConversationId(conversationId)
  if (!dispatch) {
    return { ok: false, message: 'VK не настроен для этого диалога.' }
  }

  // 1) Upload the bytes to VK → attachment descriptor (+ display url).
  const up = asPhoto
    ? await uploadVkPhoto(
        dispatch.channel.token,
        dispatch.contactHandle,
        file,
        file.name || 'photo.jpg',
        dispatch.proxy,
      )
    : await uploadVkDoc(
        dispatch.channel.token,
        dispatch.contactHandle,
        file,
        file.name || 'file',
        dispatch.proxy,
      )
  if (!up.ok) {
    console.error('[panel] vk media upload failed:', up.error)
    return { ok: false, message: up.error || 'Не удалось загрузить файл в VK.' }
  }

  const mediaType: MediaType = asPhoto ? 'image' : 'document'
  // 2) Record the outbound row immediately so it shows in the thread.
  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: caption,
    preview: caption || MEDIA_KIND_LABEL[mediaType],
    author: session.name,
    mediaType,
    mediaMime: mime,
    mediaName: asPhoto ? undefined : file.name || undefined,
    mediaRef: up.data.url ? { url: up.data.url } : undefined,
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  // 3) Send the message with the attachment; backfill provider id or fail.
  const sent = await sendVkMessage(
    dispatch.channel.token,
    dispatch.contactHandle,
    caption,
    dispatch.proxy,
    up.data.attachment,
  )
  if (!sent.ok) {
    console.error('[panel] vk media send failed:', sent.error)
    await markMessageFailed(msg.id, sent.error).catch(() => {})
    revalidatePath('/app/inbox')
    return { ok: false, message: sent.error || 'VK отклонил отправку файла.' }
  }
  if (sent.data.messageId) {
    await setMessageProviderId(msg.id, sent.data.messageId).catch(() => {})
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Отправлено.' }
}

/**
 * Telegram media send (photo/document + optional caption). Unlike WA/VK, the
 * file is not uploaded to a CDN first — the bytes ride the job payload as
 * base64 and the worker streams them through the personal MTProto session
 * (personalSendFile). Outbound Telegram media has no persisted bytes; the
 * thread renders it via on-demand live download keyed by the backfilled
 * providerMessageId (same path as outbound voice notes).
 *
 * base64-in-jsonb is heavy, so the cap here is deliberately conservative — it
 * comfortably covers photos and everyday documents while keeping job rows sane.
 */
const TG_MEDIA_MAX_BYTES = 15 * 1024 * 1024

function classifyTelegramUpload(mime: string): {
  asPhoto: boolean
  mediaType: MediaType
} {
  // Real raster images (not webp stickers, not animated gifs) go as inline
  // photo bubbles; everything else is delivered as a document but still tagged
  // by kind so the panel renders the right player.
  if (mime.startsWith('image/') && mime !== 'image/webp' && mime !== 'image/gif') {
    return { asPhoto: true, mediaType: 'image' }
  }
  if (mime.startsWith('video/')) return { asPhoto: false, mediaType: 'video' }
  if (mime.startsWith('audio/')) return { asPhoto: false, mediaType: 'audio' }
  return { asPhoto: false, mediaType: 'document' }
}

export async function sendTelegramMediaAction(
  conversationId: string,
  file: { base64: string; mime: string; name: string },
  caption: string,
  replyToProviderId?: string,
): Promise<SimpleResult> {
  const session = await requireManager()
  if (!file?.base64) return { ok: false, message: 'Пустой файл.' }
  const approxBytes = Math.floor(file.base64.length * 0.75)
  if (approxBytes > TG_MEDIA_MAX_BYTES) {
    return { ok: false, message: 'Файл слишком большой (лимит ~15 МБ).' }
  }
  const mime = file.mime || 'application/octet-stream'
  const trimmedCaption = caption.trim()

  const conv = await getConversation(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'telegram') {
    return { ok: false, message: 'Этот способ доступен только для Telegram.' }
  }

  const { asPhoto, mediaType } = classifyTelegramUpload(mime)

  // Record the outbound row immediately so it shows in the thread; the worker
  // backfills the provider id after the actual send, and a rejected send flags
  // this row 'failed' with the reason.
  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: trimmedCaption,
    preview: trimmedCaption || MEDIA_KIND_LABEL[mediaType],
    author: session.name,
    mediaType,
    mediaMime: mime,
    mediaName: asPhoto ? undefined : file.name || undefined,
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  try {
    await enqueueJob({
      channelId: conv.channelId,
      managerId: session.sub,
      action: 'send_file',
      payload: {
        target: conv.contactHandle,
        file: file.base64,
        name: file.name || 'file',
        mime,
        asPhoto,
        caption: trimmedCaption || undefined,
        replyToProviderId: replyToProviderId || undefined,
        messageId: msg.id,
      },
    })
  } catch (err) {
    console.error('[panel] failed to enqueue send_file job:', err)
    await markMessageFailed(
      msg.id,
      'Не удалось поставить файл в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath('/app/inbox')
    return { ok: false, message: 'Не удалось отправить файл.' }
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Отправлено.' }
}
