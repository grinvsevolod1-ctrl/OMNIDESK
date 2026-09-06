import { describe, expect, it } from 'vitest'
import { initials } from './initials'

/**
 * Shared avatar-initials helper (consolidated from four identical copies).
 * The god-messenger variant intentionally differs (two letters from one word)
 * and is NOT covered here — this locks the shared single-letter-per-word
 * behavior so a future consolidation cannot silently change avatars.
 */
describe('initials', () => {
  it('takes the first letter of the first two words, uppercased', () => {
    expect(initials('Иван Иванов')).toBe('ИИ')
    expect(initials('john doe')).toBe('JD')
  })

  it('yields a single letter for a single-word name', () => {
    expect(initials('Менеджер')).toBe('М')
    expect(initials('admin')).toBe('A')
  })

  it('ignores words beyond the first two', () => {
    expect(initials('Пётр Петрович Петров')).toBe('ПП')
  })

  it('returns empty string for empty/whitespace input', () => {
    expect(initials('')).toBe('')
  })

  it('skips extra internal spaces without crashing', () => {
    // Consecutive spaces produce empty segments, which are filtered out.
    expect(initials('Анна  Каренина')).toBe('АК')
  })
})
