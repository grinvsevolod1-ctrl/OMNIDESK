import 'server-only'
import type { MediaType } from '../types'

/**
 * Small shared primitives for the AI-assist data layer, factored out of the
 * ai-assist monolith so the settings/history core and the training / corrections
 * sub-modules can share them without a circular import.
 */

/** Short human-readable stand-in for a media-only message in AI history. */
export function mediaPlaceholder(type: MediaType | null): string {
  switch (type) {
    case 'image':
      return '[фото]'
    case 'video':
    case 'video_note':
      return '[видео]'
    case 'audio':
      return '[аудио]'
    case 'voice':
      return '[голосовое сообщение]'
    case 'sticker':
      return '[стикер]'
    case 'document':
      return '[документ]'
    default:
      return '[вложение]'
  }
}

/** One training example: a client's last message plus the dialog history. */
export interface TrainingSample {
  conversationId: string
  lastClientMessage: string
  history: Array<{ role: 'client' | 'manager'; body: string }>
}
