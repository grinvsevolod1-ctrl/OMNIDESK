import type { Message } from '@/lib/types'

/**
 * Telegram-style album grouping for the inbox thread — pure logic shared by the
 * manager and curator feeds (the rendering lives in message-list.tsx).
 */

/** Max time gap for grouping consecutive media into one album (Telegram sends
 *  album members within a second or two of each other). */
export const ALBUM_TIME_WINDOW_MS = 5000

/**
 * Telegram caps an album at 10 items, and so do we: a bulk send of 100 photos
 * renders as ten neat grids instead of one 34-row wall the eye cannot scan.
 */
export const MAX_ALBUM_SIZE = 10

/** Effective media type with defensive re-typing for historical rows:
 *  telegram «кружки» ingested before video_note support were stored as
 *  voice/audio while keeping their video/* MIME. */
export function effectiveMediaType(message: Message): Message['mediaType'] {
  const t = message.mediaType
  if (
    (t === 'voice' || t === 'audio') &&
    message.mediaMime?.startsWith('video/')
  ) {
    return 'video_note'
  }
  return t
}

/** A viewable media item is an image/video/«кружок» with a streamable URL. */
export function isGalleryMedia(m: Message): boolean {
  if (!m.mediaUrl) return false
  const t = effectiveMediaType(m)
  return t === 'image' || t === 'video' || t === 'video_note'
}

/** Photos and videos — what bulk selection / download operates on. */
export function isSelectableMedia(m: Message): boolean {
  if (!m.mediaUrl || m.deletedAt) return false
  const t = effectiveMediaType(m)
  return t === 'image' || t === 'video'
}

/**
 * Do two consecutive messages belong to the same Telegram-style album? Only
 * photos and videos group (stickers, кружки, voice, files stay standalone), and
 * only within the same direction and a few seconds of each other — exactly how
 * a batch of photos arrives from / is sent to the provider. Deleted messages
 * never group so their marker stays readable.
 */
export function sameAlbum(a: Message, b: Message): boolean {
  if (a.deletedAt || b.deletedAt) return false
  if (a.direction !== b.direction) return false
  const visual = (m: Message) =>
    m.mediaType === 'image' || m.mediaType === 'video'
  if (!visual(a) || !visual(b)) return false
  const gap = Math.abs(
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  return gap <= ALBUM_TIME_WINDOW_MS
}

export interface AlbumIndex {
  heads: Map<string, { items: Message[]; endIndex: number }>
  skip: Set<string>
}

/**
 * Pre-compute albums for a thread: map each album HEAD id → its members and the
 * index right after the album (so tail-corner rounding can look past the group),
 * and a set of non-head member ids to SKIP in the render loop. Singles never
 * enter the map, so non-media threads pay almost nothing. Runs longer than
 * MAX_ALBUM_SIZE are split into consecutive albums of at most that size.
 */
export function computeAlbums(
  thread: Message[],
  maxSize: number = MAX_ALBUM_SIZE,
): AlbumIndex {
  const heads = new Map<string, { items: Message[]; endIndex: number }>()
  const skip = new Set<string>()
  let i = 0
  while (i < thread.length) {
    let j = i + 1
    while (j < thread.length && sameAlbum(thread[j - 1], thread[j])) j++
    if (j - i >= 2) {
      for (let start = i; start < j; start += maxSize) {
        const end = Math.min(start + maxSize, j)
        // A leftover of exactly one item stays a single bubble.
        if (end - start < 2) break
        const items = thread.slice(start, end)
        heads.set(items[0].id, { items, endIndex: end })
        for (let k = start + 1; k < end; k++) skip.add(thread[k].id)
      }
    }
    i = j
  }
  return { heads, skip }
}
