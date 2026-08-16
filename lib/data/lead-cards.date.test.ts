import { describe, expect, it } from 'vitest'
import { toDateOnly } from './lead-cards'

/**
 * Regression: node-postgres parses DATE columns into a JS Date at
 * SERVER-LOCAL midnight. The old implementation went through toISOString()
 * (UTC), which shifted the date back one day on servers whose timezone is
 * ahead of UTC (MSK VPS) — a curator confirming a status "today" was seen as
 * "yesterday" and the workspace stayed locked. toDateOnly() must return the
 * LOCAL calendar date of the parsed value.
 */
describe('toDateOnly', () => {
  it('returns null for empty values', () => {
    expect(toDateOnly(null)).toBeNull()
    expect(toDateOnly(undefined)).toBeNull()
    expect(toDateOnly('')).toBeNull()
  })

  it('slices plain date strings', () => {
    expect(toDateOnly('2026-08-07')).toBe('2026-08-07')
    expect(toDateOnly('2026-08-07T00:00:00.000Z')).toBe('2026-08-07')
  })

  it('uses LOCAL calendar components for Date values (pg DATE parsing)', () => {
    // pg would produce local-midnight Dates like this for DATE '2026-08-07'.
    const localMidnight = new Date(2026, 7, 7, 0, 0, 0)
    expect(toDateOnly(localMidnight)).toBe('2026-08-07')
  })

  it('does not shift the date back a day in timezones ahead of UTC', () => {
    // In a TZ ahead of UTC, local midnight is the PREVIOUS day in UTC —
    // toISOString().slice(0,10) would have returned 2026-08-06 here when the
    // process TZ is e.g. Europe/Moscow. Local components never shift.
    const localMidnight = new Date(2026, 7, 7)
    const viaLocal = toDateOnly(localMidnight)
    expect(viaLocal).toBe('2026-08-07')
    if (localMidnight.getTimezoneOffset() < 0) {
      // Only meaningful when the test itself runs ahead of UTC.
      expect(localMidnight.toISOString().slice(0, 10)).not.toBe(viaLocal)
    }
  })
})
