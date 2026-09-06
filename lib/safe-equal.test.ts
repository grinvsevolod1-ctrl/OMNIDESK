import { describe, expect, it } from 'vitest'
import { safeEqual } from './safe-equal'

/**
 * The shared constant-time comparison used by auth, god-gate and
 * messenger-gate. Previously copied byte-for-byte into three files; these
 * tests guard the single source of truth for the security primitive.
 */
describe('safeEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('secret', 'secret')).toBe(true)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('пароль-с-юникодом', 'пароль-с-юникодом')).toBe(true)
  })

  it('returns false for different strings', () => {
    expect(safeEqual('secret', 'Secret')).toBe(false)
    expect(safeEqual('secret', 'secret ')).toBe(false)
    expect(safeEqual('a', 'b')).toBe(false)
  })

  it('returns false regardless of length difference (no early length leak)', () => {
    // SHA-256 hashing both sides means unequal lengths still compare in
    // constant time and simply return false.
    expect(safeEqual('short', 'a-much-longer-value-here')).toBe(false)
    expect(safeEqual('x', '')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
  })

  it('is order-independent for equality', () => {
    const a = 'token-abc-123'
    const b = 'token-abc-123'
    expect(safeEqual(a, b)).toBe(safeEqual(b, a))
  })
})
