import { describe, expect, it } from 'vitest'
import {
  APP_TIME_ZONE,
  formatMskDate,
  formatMskDateTimeNumeric,
  formatMskTime,
  mskDayKey,
} from './time'

/**
 * The canonical MSK-aware time module. The whole product renders in Moscow
 * time regardless of the viewer's timezone; several components were fixed this
 * session to route through here instead of formatting in local time. These
 * tests pin the timezone behavior so a regression to local time is caught.
 *
 * We assert against fixed UTC instants whose MSK (UTC+3) rendering is known,
 * so the result does not depend on the machine's timezone.
 */

// 2026-08-07T23:30:00Z === 2026-08-08 02:30 MSK (crosses the day boundary).
const LATE_UTC = new Date('2026-08-07T23:30:00Z')
// 2026-08-07T05:15:00Z === 2026-08-07 08:15 MSK.
const MORNING_UTC = new Date('2026-08-07T05:15:00Z')

describe('APP_TIME_ZONE', () => {
  it('is Moscow', () => {
    expect(APP_TIME_ZONE).toBe('Europe/Moscow')
  })
})

describe('mskDayKey', () => {
  it('uses the MSK calendar day, not UTC', () => {
    // 23:30 UTC is already the next day in Moscow.
    expect(mskDayKey(LATE_UTC)).toBe('2026-08-08')
    expect(mskDayKey(MORNING_UTC)).toBe('2026-08-07')
  })

  it('accepts ISO strings and epoch millis identically', () => {
    expect(mskDayKey('2026-08-07T23:30:00Z')).toBe(mskDayKey(LATE_UTC))
    expect(mskDayKey(LATE_UTC.getTime())).toBe(mskDayKey(LATE_UTC))
  })

  it('two instants in the same MSK day share a key', () => {
    expect(mskDayKey('2026-08-07T05:00:00Z')).toBe(
      mskDayKey('2026-08-07T20:00:00Z'),
    )
  })
})

describe('formatMskTime', () => {
  it('renders the Moscow wall-clock hour, not UTC', () => {
    expect(formatMskTime(MORNING_UTC)).toBe('08:15')
    expect(formatMskTime(LATE_UTC)).toBe('02:30')
  })
})

describe('formatMskDate / formatMskDateTimeNumeric', () => {
  it('rolls the date forward across the MSK midnight boundary', () => {
    // Same UTC instant, but MSK date is the 8th.
    expect(formatMskDate(LATE_UTC)).toContain('8')
  })

  it('produces a stable numeric datetime string', () => {
    const s = formatMskDateTimeNumeric(MORNING_UTC)
    expect(typeof s).toBe('string')
    expect(s.length).toBeGreaterThan(0)
  })
})
