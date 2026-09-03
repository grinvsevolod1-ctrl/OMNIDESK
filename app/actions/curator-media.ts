'use server'

import { revalidatePath } from 'next/cache'
import { requireCurator } from '@/lib/auth'
import {
  addMessage,
  getVkDispatchByConversationId,
  getWhatsappCloudDispatchByConversationId,
  markMessageFailed,
  setMessageProviderId,
} from '@/lib/data'
import { getConversationForCurator } from '@/lib/data/curator-conversations'
import {
  sendMessage as sendVkMessage,
  uploadDocAttachment as uploadVkDoc,
  uploadPhotoAttachment as uploadVkPhoto,
} from '@/lib/vk'
import { sendMedia, uploadMedia, type WaMediaKind } from '@/lib/whatsapp-cloud'
import type { MediaType } from '@/lib/types'

export interface SimpleResult {
  ok: boolean
  message: string
}

const CURATOR_CHATS_PATH = '/curator/chats'

/**
 * Отправка вложений куратором — зеркало app/actions/account-media.ts, но со
 * скоупом по curator_id (getConversationForCurator + addMessage с curatorId).
 * Поддерживаем текст + фото/файлы (решение пользователя), поэтому реализуем
 * WhatsApp и VK — единственные каналы с медиа-загрузкой через панель; Telegram
 * медиа в панели отправляется отдельным путём и в объём куратора не входит.
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

/** Куратор: отправка файла в WhatsApp-диалог. */
export async function sendCuratorWhatsappMediaAction(
  conversationId: string,
  formData: FormData,
): Promise<SimpleResult> {
  const session = await requireCurator()

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Файл не выбран.' }
  }
  const caption = String(formData.get('caption') ?? '').trim()

  const conv = await getConversationForCurator(conversationId, session.sub)
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
    return { ok: false, message: 'WhatsApp не настроен — обратитесь к администратору.' }
  }

  const up = await uploadMedia(
    dispatch.phoneNumberId,
    dispatch.token,
    file,
    mime,
    file.name || 'file',
    dispatch.proxy,
  )
  if (!up.ok) {
    console.error('[panel] curator whatsapp media upload failed:', up.error)
    return { ok: false, message: 'Не удалось загрузить файл в WhatsApp.' }
  }

  const msg = await addMessage({
    conversationId,
    managerId: conv.managerId,
    curatorId: session.sub,
    body: caption,
    preview: caption || MEDIA_KIND_LABEL[mediaType],
    author: session.name,
    mediaType,
    mediaMime: mime,
    mediaName: kind === 'document' ? file.name || undefined : undefined,
    mediaRef: { waMediaId: up.data.id },
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

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
    console.error('[panel] curator whatsapp media send failed:', sent.error)
    await markMessageFailed(msg.id, sent.error).catch(() => {})
    revalidatePath(CURATOR_CHATS_PATH)
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

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: 'Файл отправлен.' }
}

const VK_MEDIA_LIMITS = {
  photo: 25 * 1024 * 1024,
  doc: 200 * 1024 * 1024,
}

/** Куратор: отправка файла в VK-диалог. */
export async function sendCuratorVkMediaAction(
  conversationId: string,
  formData: FormData,
): Promise<SimpleResult> {
  const session = await requireCurator()

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Файл не выбран.' }
  }
  const caption = String(formData.get('caption') ?? '').trim()

  const conv = await getConversationForCurator(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'vk') {
    return { ok: false, message: 'Это действие доступно только для VK.' }
  }

  const mime = file.type || 'application/octet-stream'
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
    console.error('[panel] curator vk media upload failed:', up.error)
    return { ok: false, message: up.error || 'Не удалось загрузить файл в VK.' }
  }

  const mediaType: MediaType = asPhoto ? 'image' : 'document'
  const msg = await addMessage({
    conversationId,
    managerId: conv.managerId,
    curatorId: session.sub,
    body: caption,
    preview: caption || MEDIA_KIND_LABEL[mediaType],
    author: session.name,
    mediaType,
    mediaMime: mime,
    mediaName: asPhoto ? undefined : file.name || undefined,
    mediaRef: up.data.url ? { url: up.data.url } : undefined,
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  const sent = await sendVkMessage(
    dispatch.channel.token,
    dispatch.contactHandle,
    caption,
    dispatch.proxy,
    up.data.attachment,
  )
  if (!sent.ok) {
    console.error('[panel] curator vk media send failed:', sent.error)
    await markMessageFailed(msg.id, sent.error).catch(() => {})
    revalidatePath(CURATOR_CHATS_PATH)
    return { ok: false, message: sent.error || 'VK отклонил отправку файла.' }
  }
  if (sent.data.messageId) {
    await setMessageProviderId(msg.id, sent.data.messageId).catch(() => {})
  }

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: 'Отправлено.' }
}
