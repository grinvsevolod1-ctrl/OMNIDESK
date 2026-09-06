import { describe, it, expect } from 'vitest'
import { isQuietNow } from './runtime'

/**
 * Quiet-window logic for the follow-up autopilot. `isQuietNow` decides whether
 * a nudge is suppressed because it's the middle of the night for the client.
 * The window is [start, end) in whole hours, evaluated in the given IANA tz.
 * These cases pin the three regimes — disabled, same-day, overnight — plus the
 * tz-resolution fallback, so a refactor can't silently start messaging people
 * at 3am.
 */
describe('isQuietNow', () => {
  // A fixed instant we can reason about across zones:
  // 2024-01-15T00:00:00Z == 03:00 in Moscow (UTC+3), 19:00 in New York (UTC-5).
  const instant = new Date('2024-01-15T00:00:00Z')

  it('is never quiet when the window is empty (start === end)', () => {
    expect(isQuietNow(0, 0, 'Europe/Moscow', instant)).toBe(false)
    expect(isQuietNow(9, 9, 'Europe/Moscow', instant)).toBe(false)
    expect(isQuietNow(22, 22, 'America/New_York', instant)).toBe(false)
  })

  it('handles a same-day window (start < end)', () => {
    // Moscow hour is 03:00.
    expect(isQuietNow(1, 6, 'Europe/Moscow', instant)).toBe(true) // 1 <= 3 < 6
    expect(isQuietNow(4, 6, 'Europe/Moscow', instant)).toBe(false) // 3 < 4
    expect(isQuietNow(0, 3, 'Europe/Moscow', instant)).toBe(false) // end exclusive: 3 is not < 3
    expect(isQuietNow(3, 8, 'Europe/Moscow', instant)).toBe(true) // start inclusive: 3 >= 3
  })

  it('handles an overnight window (end <= start)', () => {
    // Moscow hour is 03:00, a classic 21 -> 09 quiet window covers it.
    expect(isQuietNow(21, 9, 'Europe/Moscow', instant)).toBe(true) // 3 < 9
    // New York hour is 19:00 for the same instant.
    expect(isQuietNow(21, 9, 'America/New_York', instant)).toBe(false) // 19 < 21 and 19 >= 9
    expect(isQuietNow(18, 9, 'America/New_York', instant)).toBe(true) // 19 >= 18
  })

  it('resolves the window in the given timezone, not the host tz', () => {
    // Same instant, opposite verdicts for the same window purely due to tz.
    const window = { start: 2, end: 5 }
    expect(isQuietNow(window.start, window.end, 'Europe/Moscow', instant)).toBe(
      true,
    ) // 03:00 MSK is inside [2,5)
    expect(
      isQuietNow(window.start, window.end, 'America/New_York', instant),
    ).toBe(false) // 19:00 NY is outside [2,5)
  })

  it('falls back to Moscow time when the tz string is invalid', () => {
    // An unparseable tz must not throw; it resolves as Europe/Moscow (03:00).
    expect(isQuietNow(1, 6, 'Not/AZone', instant)).toBe(true)
    expect(isQuietNow(1, 6, '', instant)).toBe(true)
  })
})
