import 'server-only'
import { proxiedFetch, type ProxyDescriptor } from './proxy-agent'
import {
  vkCall,
  type VkAttachment,
  type VkResult,
} from './vk-core'

/**
 * VK media: outbound attachment uploads (photo/doc three-step flow) and
 * inbound attachment parsing for the inbox. Split from vk.ts; import from
 * '@/lib/vk' which re-exports the public surface.
 */

/** A saved/sent attachment: the `attachment` param for messages.send plus an
 * optional CDN url so the panel can re-display the media it just sent. */
export interface VkUploadedAttachment {
  attachment: string
  url: string | null
}

/** Pick the widest available size URL from a VK photo `sizes` array. */
function largestPhotoUrl(
  sizes: { url?: string; width?: number }[] | undefined,
): string | null {
  if (!sizes?.length) return null
  let best: { url?: string; width?: number } | null = null
  for (const s of sizes) {
    if (!s.url) continue
    if (!best || (s.width ?? 0) > (best.width ?? 0)) best = s
  }
  return best?.url ?? null
}

/**
 * Upload a photo into a dialog and return the attachment descriptor
 * (`photo{owner}_{id}`) usable by sendMessage, plus a CDN url for display.
 * Three-step VK flow: get an upload server, POST the bytes, then save. All hops
 * go through the account's proxy.
 */
export async function uploadPhotoAttachment(
  token: string,
  peerId: string | number,
  bytes: Blob,
  filename: string,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<VkUploadedAttachment>> {
  const server = await vkCall<{ upload_url?: string }>(
    'photos.getMessagesUploadServer',
    token,
    { peer_id: peerId },
    proxy,
  )
  if (!server.ok) return server
  if (!server.data.upload_url) {
    return { ok: false, error: 'VK не вернул адрес загрузки фото.' }
  }

  let uploaded: { server?: number; photo?: string; hash?: string }
  try {
    const form = new FormData()
    form.append('photo', bytes, filename || 'photo.jpg')
    const up = await proxiedFetch(
      server.data.upload_url,
      { method: 'POST', body: form, cache: 'no-store' },
      proxy,
    )
    uploaded = (await up.json()) as typeof uploaded
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Не удалось загрузить фото в VK.',
    }
  }
  if (!uploaded.photo || uploaded.server == null || !uploaded.hash) {
    return { ok: false, error: 'VK вернул некорректный ответ при загрузке фото.' }
  }

  const saved = await vkCall<
    { owner_id: number; id: number; sizes?: { url?: string; width?: number }[] }[]
  >(
    'photos.saveMessagesPhoto',
    token,
    {
      photo: uploaded.photo,
      server: uploaded.server,
      hash: uploaded.hash,
    },
    proxy,
  )
  if (!saved.ok) return saved
  const p = saved.data[0]
  if (!p) return { ok: false, error: 'VK не сохранил загруженное фото.' }
  return {
    ok: true,
    data: { attachment: `photo${p.owner_id}_${p.id}`, url: largestPhotoUrl(p.sizes) },
  }
}

/**
 * Upload a document (any non-image file) into a dialog and return the attachment
 * descriptor (`doc{owner}_{id}`) usable by sendMessage. Same three-step VK flow
 * as photos but via docs.getMessagesUploadServer / docs.save. All hops go
 * through the account's proxy.
 */
export async function uploadDocAttachment(
  token: string,
  peerId: string | number,
  bytes: Blob,
  filename: string,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<VkUploadedAttachment>> {
  const server = await vkCall<{ upload_url?: string }>(
    'docs.getMessagesUploadServer',
    token,
    { peer_id: peerId, type: 'doc' },
    proxy,
  )
  if (!server.ok) return server
  if (!server.data.upload_url) {
    return { ok: false, error: 'VK не вернул адрес загрузки файла.' }
  }

  let uploaded: { file?: string }
  try {
    const form = new FormData()
    form.append('file', bytes, filename || 'file')
    const up = await proxiedFetch(
      server.data.upload_url,
      { method: 'POST', body: form, cache: 'no-store' },
      proxy,
    )
    uploaded = (await up.json()) as typeof uploaded
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Не удалось загрузить файл в VK.',
    }
  }
  if (!uploaded.file) {
    return { ok: false, error: 'VK вернул некорректный ответ при загрузке файла.' }
  }

  const saved = await vkCall<{
    type?: string
    doc?: { id?: number; owner_id?: number; url?: string }
  }>(
    'docs.save',
    token,
    { file: uploaded.file, title: filename || 'file' },
    proxy,
  )
  if (!saved.ok) return saved
  const node = saved.data.doc
  if (!node?.id || node.owner_id == null) {
    return { ok: false, error: 'VK не сохранил загруженный файл.' }
  }
  return {
    ok: true,
    data: { attachment: `doc${node.owner_id}_${node.id}`, url: node.url ?? null },
  }
}

/** Parsed media descriptor for an inbound VK attachment. */
export interface ParsedVkMedia {
  /** Conversation-list preview label when the message has no text. */
  preview: string
  mediaType: 'image' | 'voice' | 'audio' | 'document' | 'sticker' | null
  mediaMime: string | null
  mediaName: string | null
  /** `{ url }` streamed by the media proxy; null for kinds we can't download. */
  mediaRef: { url: string } | null
}

/** Pick the widest url from a VK sizes array (handles both `url` and `src`). */
function widestUrl(
  sizes: { url?: string; src?: string; width?: number }[] | undefined,
): string | null {
  if (!sizes?.length) return null
  let best: { url?: string; src?: string; width?: number } | null = null
  for (const s of sizes) {
    if (!s.url && !s.src) continue
    if (!best || (s.width ?? 0) > (best.width ?? 0)) best = s
  }
  return best?.url ?? best?.src ?? null
}

/**
 * Turn a VK message's attachments into a single media descriptor for the inbox.
 * VK messages can carry several attachments; we surface the FIRST downloadable
 * one (photo/doc/voice/audio/sticker) and fall back to a text placeholder for
 * kinds we can't stream (video/wall/link/…). Returns null when there is nothing
 * to show.
 */
export function parseVkAttachments(
  attachments: VkAttachment[] | undefined,
): ParsedVkMedia | null {
  if (!attachments?.length) return null

  for (const a of attachments) {
    switch (a.type) {
      case 'photo': {
        const url = widestUrl(a.photo?.sizes)
        if (url)
          return { preview: '[Фото]', mediaType: 'image', mediaMime: 'image/jpeg', mediaName: null, mediaRef: { url } }
        break
      }
      case 'sticker': {
        const url = widestUrl(a.sticker?.images)
        if (url)
          return { preview: '[Стикер]', mediaType: 'sticker', mediaMime: 'image/png', mediaName: null, mediaRef: { url } }
        break
      }
      case 'audio_message': {
        const url = a.audio_message?.link_mp3 || a.audio_message?.link_ogg
        if (url) {
          const mime = a.audio_message?.link_mp3 ? 'audio/mpeg' : 'audio/ogg'
          return { preview: '[Голосовое сообщение]', mediaType: 'voice', mediaMime: mime, mediaName: null, mediaRef: { url } }
        }
        break
      }
      case 'doc': {
        const url = a.doc?.url
        const name = a.doc?.title
          ? a.doc.ext && !a.doc.title.endsWith(`.${a.doc.ext}`)
            ? `${a.doc.title}.${a.doc.ext}`
            : a.doc.title
          : null
        if (url)
          return { preview: name ? `[Документ: ${name}]` : '[Документ]', mediaType: 'document', mediaMime: null, mediaName: name, mediaRef: { url } }
        break
      }
      case 'audio': {
        const title = [a.audio?.artist, a.audio?.title].filter(Boolean).join(' — ')
        if (a.audio?.url)
          return { preview: title ? `[Аудио: ${title}]` : '[Аудио]', mediaType: 'audio', mediaMime: 'audio/mpeg', mediaName: title || null, mediaRef: { url: a.audio.url } }
        return { preview: title ? `[Аудио: ${title}]` : '[Аудио]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
      }
      case 'video':
        return { preview: a.video?.title ? `[Видео: ${a.video.title}]` : '[Видео]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
      case 'link':
        return { preview: a.link?.title ? `[Ссылка: ${a.link.title}]` : '[Ссылка]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
      case 'wall':
        return { preview: '[Запись со стены]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
      default:
        break
    }
  }
  // Unknown/undownloadable attachment(s): show a generic placeholder.
  return { preview: '[Вложение]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
}
