import { describe, expect, it } from 'vitest'
import type { Message } from './types'
import {
  albumCellSpansRow,
  albumGridCols,
  computeAlbums,
  isSelectableMedia,
  MAX_ALBUM_SIZE,
  sameAlbum,
} from './media-albums'

function photo(
  i: number,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: `m${i}`,
    conversationId: 'c1',
    direction: 'out',
    body: '',
    author: 'A',
    createdAt: new Date(1_700_000_000_000 + i * 500).toISOString(),
    mediaType: 'image',
    mediaMime: 'image/jpeg',
    mediaUrl: `/api/media/m${i}`,
    ...overrides,
  } as Message
}

describe('albumGridCols', () => {
  it('lays 2–4 items two-up and 5+ in three columns', () => {
    expect(albumGridCols(2)).toBe(2)
    expect(albumGridCols(3)).toBe(2)
    expect(albumGridCols(4)).toBe(2)
    expect(albumGridCols(5)).toBe(3)
    expect(albumGridCols(10)).toBe(3)
  })
})

describe('albumCellSpansRow', () => {
  it('spans only the first cell of a 3-item album', () => {
    expect(albumCellSpansRow(3, 0)).toBe(true)
    expect(albumCellSpansRow(3, 1)).toBe(false)
    expect(albumCellSpansRow(2, 0)).toBe(false)
    expect(albumCellSpansRow(4, 0)).toBe(false)
  })
})

describe('sameAlbum', () => {
  it('groups photos/videos from one side within the time window', () => {
    expect(sameAlbum(photo(1), photo(2))).toBe(true)
    expect(sameAlbum(photo(1), photo(2, { mediaType: 'video' }))).toBe(true)
  })

  it('never groups across direction, deleted rows or non-visual media', () => {
    expect(sameAlbum(photo(1), photo(2, { direction: 'in' }))).toBe(false)
    expect(
      sameAlbum(photo(1), photo(2, { deletedAt: new Date().toISOString() })),
    ).toBe(false)
    expect(sameAlbum(photo(1), photo(2, { mediaType: 'document' }))).toBe(false)
    expect(sameAlbum(photo(1), photo(2, { mediaType: 'sticker' }))).toBe(false)
  })

  it('breaks the album when the gap exceeds the window', () => {
    const late = photo(2, {
      createdAt: new Date(1_700_000_000_000 + 60_000).toISOString(),
    })
    expect(sameAlbum(photo(1), late)).toBe(false)
  })
})

describe('computeAlbums', () => {
  it('leaves singles alone and marks members of a group', () => {
    const thread = [photo(1), photo(2), photo(3), photo(4, { mediaType: 'document' })]
    const { heads, skip } = computeAlbums(thread)
    expect([...heads.keys()]).toEqual(['m1'])
    expect(heads.get('m1')?.items.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(heads.get('m1')?.endIndex).toBe(3)
    expect([...skip]).toEqual(['m2', 'm3'])
  })

  it('splits a long run into consecutive albums of at most MAX_ALBUM_SIZE', () => {
    // 100 photos sent in one bulk batch → 10 grids of 10, like Telegram.
    const thread = Array.from({ length: 100 }, (_, i) => photo(i))
    const { heads, skip } = computeAlbums(thread)
    expect(heads.size).toBe(100 / MAX_ALBUM_SIZE)
    for (const [, album] of heads) {
      expect(album.items.length).toBe(MAX_ALBUM_SIZE)
    }
    // Every non-head member is skipped in the render loop.
    expect(skip.size).toBe(100 - heads.size)
    // Each head's endIndex points right after ITS grid, not after the run.
    expect(heads.get('m0')?.endIndex).toBe(10)
    expect(heads.get('m10')?.endIndex).toBe(20)
  })

  it('keeps a trailing single out of the grid when the run is 11 long', () => {
    const thread = Array.from({ length: 11 }, (_, i) => photo(i))
    const { heads, skip } = computeAlbums(thread)
    expect(heads.size).toBe(1)
    expect(skip.has('m10')).toBe(false)
  })
})

describe('isSelectableMedia', () => {
  it('accepts photos and videos with a URL, rejects the rest', () => {
    expect(isSelectableMedia(photo(1))).toBe(true)
    expect(isSelectableMedia(photo(1, { mediaType: 'video' }))).toBe(true)
    expect(isSelectableMedia(photo(1, { mediaUrl: undefined }))).toBe(false)
    expect(isSelectableMedia(photo(1, { mediaType: 'sticker' }))).toBe(false)
    expect(isSelectableMedia(photo(1, { mediaType: 'document' }))).toBe(false)
    expect(
      isSelectableMedia(photo(1, { deletedAt: new Date().toISOString() })),
    ).toBe(false)
  })
})
