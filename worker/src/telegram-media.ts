import { Api } from 'telegram'

/**
 * Telegram media classification, extracted from telegram.ts and re-exported
 * from it for backward compatibility. Maps a Telegram message's media onto our
 * generic media taxonomy plus a human placeholder.
 */

/** Recognised media kinds extracted from a Telegram message. */
export interface TgMediaInfo {
  mediaType: 'image' | 'video' | 'video_note' | 'audio' | 'voice' | 'sticker' | 'document'
  mediaMime: string | null
  mediaName: string | null
  /** Friendly placeholder shown when there's no text caption. */
  placeholder: string
}

/**
 * Classify the media carried by a Telegram message into our generic media
 * taxonomy plus a human placeholder. Returns null for plain-text messages.
 */
export function classifyTgMedia(msg: Api.Message): TgMediaInfo | null {
  const media = msg.media
  if (!media) return null

  // Photos.
  if (media instanceof Api.MessageMediaPhoto) {
    return {
      mediaType: 'image',
      mediaMime: 'image/jpeg',
      mediaName: null,
      placeholder: '[Фото]',
    }
  }

  // Documents (covers stickers, voice, video notes, audio, video, files).
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document
    const mime =
      doc && 'mimeType' in doc && doc.mimeType ? String(doc.mimeType) : null
    const attrs =
      doc && 'attributes' in doc && Array.isArray(doc.attributes)
        ? doc.attributes
        : []

    let fileName: string | null = null
    let isSticker = false
    let stickerEmoji = ''
    let isRoundVideo = false
    let isVideo = false
    let isVoice = false
    let isAudio = false

    for (const a of attrs) {
      if (a instanceof Api.DocumentAttributeFilename) fileName = a.fileName
      else if (a instanceof Api.DocumentAttributeSticker) {
        isSticker = true
        stickerEmoji = a.alt || ''
      } else if (a instanceof Api.DocumentAttributeVideo) {
        isVideo = true
        if ('round' in a && a.round) isRoundVideo = true
      } else if (a instanceof Api.DocumentAttributeAudio) {
        isAudio = true
        if ('voice' in a && a.voice) isVoice = true
      }
    }

    if (isSticker) {
      return {
        mediaType: 'sticker',
        mediaMime: mime ?? 'image/webp',
        mediaName: null,
        placeholder: stickerEmoji ? `${stickerEmoji} [Стикер]` : '[Стикер]',
      }
    }
    // Round «кружки» BEFORE voice: some clients attach both a video(round)
    // and an audio attribute to video messages — checking voice first used
    // to misfile them as plain audio.
    if (isRoundVideo) {
      return {
        mediaType: 'video_note',
        mediaMime: mime ?? 'video/mp4',
        mediaName: null,
        placeholder: '[Видеосообщение]',
      }
    }
    if (isVoice) {
      return {
        mediaType: 'voice',
        mediaMime: mime ?? 'audio/ogg',
        mediaName: null,
        placeholder: '[Голосовое сообщение]',
      }
    }
    if (isAudio) {
      return {
        mediaType: 'audio',
        mediaMime: mime ?? 'audio/mpeg',
        mediaName: fileName,
        placeholder: '[Аудио]',
      }
    }
    if (isVideo) {
      return {
        mediaType: 'video',
        mediaMime: mime ?? 'video/mp4',
        mediaName: fileName,
        placeholder: '[Видео]',
      }
    }
    return {
      mediaType: 'document',
      mediaMime: mime,
      mediaName: fileName,
      placeholder: fileName ? `[Файл: ${fileName}]` : '[Файл]',
    }
  }

  return null
}
