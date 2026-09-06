import { describe, expect, it } from 'vitest'
import type { Message } from './types'
import { bulkFilenames, mediaFilename, zipFilename } from './media-download'
import { chunkFiles, MAX_FILES_PER_REQUEST } from './media-batch'

function msg(overrides: Partial<Message>): Message {
  return {
    id: 'abcdef1234567890',
    conversationId: 'c1',
    direction: 'in',
    body: '',
    author: 'A',
    createdAt: '2026-09-06T10:00:00.000Z',
    mediaType: 'image',
    mediaUrl: '/api/media/x',
    ...overrides,
  } as Message
}

describe('mediaFilename', () => {
  it('prefers the stored name', () => {
    expect(mediaFilename(msg({ mediaName: 'scan.pdf', mediaType: 'document' }))).toBe(
      'scan.pdf',
    )
  })

  it('derives a typed stem and an extension from the MIME', () => {
    expect(mediaFilename(msg({ mediaMime: 'image/png' }))).toBe('photo-abcdef12.png')
    expect(mediaFilename(msg({ mediaType: 'video', mediaMime: 'video/mp4' }))).toBe(
      'video-abcdef12.mp4',
    )
    expect(mediaFilename(msg({}))).toBe('photo-abcdef12.jpg')
  })
})

describe('bulkFilenames', () => {
  it('prefixes thread-order ordinals and dedupes collisions', () => {
    const names = bulkFilenames([
      msg({ id: 'a1', mediaName: 'IMG_0001.jpg' }),
      msg({ id: 'a2', mediaName: 'IMG_0001.jpg' }),
      msg({ id: 'a3' }),
    ])
    expect(names[0]).toBe('001-IMG_0001.jpg')
    // Same ordinal never repeats, so identical source names stay distinct.
    expect(names[1]).toBe('002-IMG_0001.jpg')
    expect(names[2]).toBe('003-photo-a3.jpg')
    expect(new Set(names).size).toBe(3)
  })

  it('strips path separators from user-supplied names', () => {
    const [name] = bulkFilenames([msg({ mediaName: '../../etc/passwd' })])
    expect(name).not.toContain('/')
    expect(name).toBe('001-.._.._etc_passwd')
  })

  it('widens the ordinal for 1000+ items', () => {
    const names = bulkFilenames(
      Array.from({ length: 1000 }, (_, i) => msg({ id: `m${i}` })),
    )
    expect(names[0].startsWith('0001-')).toBe(true)
    expect(names[999].startsWith('1000-')).toBe(true)
  })
})

describe('zipFilename', () => {
  it('embeds a sanitised contact name and the date', () => {
    const d = new Date('2026-09-06T12:00:00Z')
    expect(zipFilename('Иван Петров', d)).toBe('photos-Иван-Петров-2026-09-06.zip')
    expect(zipFilename(undefined, d)).toBe('photos-2026-09-06.zip')
    expect(zipFilename('a/b:c', d)).toBe('photos-abc-2026-09-06.zip')
  })
})

describe('chunkFiles', () => {
  it('splits into ordered chunks of the request cap', () => {
    const items = Array.from({ length: 45 }, (_, i) => i)
    const chunks = chunkFiles(items)
    expect(chunks.length).toBe(Math.ceil(45 / MAX_FILES_PER_REQUEST))
    expect(chunks.flat()).toEqual(items)
    expect(chunks.every((c) => c.length <= MAX_FILES_PER_REQUEST)).toBe(true)
  })

  it('handles empty input and rejects a non-positive size', () => {
    expect(chunkFiles([])).toEqual([])
    expect(() => chunkFiles([1], 0)).toThrow()
  })
})
