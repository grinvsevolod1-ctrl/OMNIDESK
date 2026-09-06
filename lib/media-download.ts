import type { Message } from '@/lib/types'

/**
 * Pure naming helpers for single and bulk media downloads. The browser-only
 * parts (fetching, Web Share, ZIP packing) live in media-download-client.ts.
 */

/** Suggest a filename for a downloaded media item from its type/name. */
export function mediaFilename(message: Message): string {
  if (message.mediaName) return message.mediaName
  const ext = extensionFor(message)
  const stem =
    message.mediaType === 'image'
      ? 'photo'
      : message.mediaType === 'video' || message.mediaType === 'video_note'
        ? 'video'
        : 'media'
  return `${stem}-${message.id.slice(0, 8)}.${ext}`
}

function extensionFor(message: Message): string {
  const fromMime = extensionFromMime(message.mediaMime)
  if (fromMime) return fromMime
  return message.mediaType === 'image'
    ? 'jpg'
    : message.mediaType === 'video' || message.mediaType === 'video_note'
      ? 'mp4'
      : message.mediaType === 'voice' || message.mediaType === 'audio'
        ? 'ogg'
        : 'bin'
}

function extensionFromMime(mime: string | undefined): string | null {
  if (!mime) return null
  const m = mime.toLowerCase().split(';')[0].trim()
  const table: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
  }
  return table[m] ?? null
}

/**
 * File names for a bulk download: every item gets a zero-padded ordinal prefix
 * so the files sort in thread order on disk / in the gallery, and duplicates
 * are disambiguated — a phone exports every photo as IMG_0001.jpg otherwise.
 */
export function bulkFilenames(messages: Message[]): string[] {
  const width = Math.max(3, String(messages.length).length)
  const seen = new Map<string, number>()
  return messages.map((m, i) => {
    const base = mediaFilename(m)
    const ordinal = String(i + 1).padStart(width, '0')
    let name = `${ordinal}-${sanitize(base)}`
    const dup = seen.get(name) ?? 0
    seen.set(name, dup + 1)
    if (dup > 0) {
      const dot = name.lastIndexOf('.')
      name =
        dot > 0
          ? `${name.slice(0, dot)}(${dup})${name.slice(dot)}`
          : `${name}(${dup})`
    }
    return name
  })
}

/** Strip path separators and control characters from a user-supplied name. */
function sanitize(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  return cleaned || 'file'
}

/** Archive name: `photos-<contact>-<yyyy-mm-dd>.zip`, safe for every OS. */
export function zipFilename(contactName: string | undefined, now = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  const who = (contactName ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .trim()
    .slice(0, 40)
  return who ? `photos-${who}-${date}.zip` : `photos-${date}.zip`
}
