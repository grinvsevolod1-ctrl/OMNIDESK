import { describe, expect, it } from 'vitest'
import { newClientMessageId, normalizeClientMessageId } from './client-message-id'

describe('client-message-id', () => {
  it('mints RFC 4122-shaped ids that round-trip through normalisation', () => {
    for (let i = 0; i < 20; i++) {
      const id = newClientMessageId()
      expect(normalizeClientMessageId(id)).toBe(id.toLowerCase())
    }
  })

  it('mints unique ids', () => {
    const seen = new Set(Array.from({ length: 200 }, newClientMessageId))
    expect(seen.size).toBe(200)
  })

  it('drops anything that is not a UUID (never a 500 on the UUID column)', () => {
    expect(normalizeClientMessageId(undefined)).toBeUndefined()
    expect(normalizeClientMessageId(null)).toBeUndefined()
    expect(normalizeClientMessageId('')).toBeUndefined()
    expect(normalizeClientMessageId('tmp_1712345')).toBeUndefined()
    expect(normalizeClientMessageId("'; DROP TABLE messages; --")).toBeUndefined()
    expect(normalizeClientMessageId('123e4567-e89b-12d3-a456-42661417400')).toBeUndefined()
  })

  it('accepts a canonical UUID and lowercases it', () => {
    expect(
      normalizeClientMessageId('  123E4567-E89B-42D3-A456-426614174000 '),
    ).toBe('123e4567-e89b-42d3-a456-426614174000')
  })
})
