import { describe, expect, it } from 'vitest'
import {
  FINAL_LEAD_STATUSES,
  isFinalLeadStatus,
  leadNeedsDailyStatus,
  needsDailyStatusUpdate,
} from './lead-status'
import { mskDayKey } from './time'

/** 12:00 MSK (09:00 UTC) — past the 10:00 MSK deadline. */
const AFTER_DEADLINE = new Date('2026-08-07T09:00:00Z')
/** 08:00 MSK (05:00 UTC) — before the deadline. */
const BEFORE_DEADLINE = new Date('2026-08-07T05:00:00Z')

describe('isFinalLeadStatus', () => {
  it('только «Отказался» и «Кинул» финальные', () => {
    expect(FINAL_LEAD_STATUSES).toEqual(['refused', 'left'])
    expect(isFinalLeadStatus('refused')).toBe(true)
    expect(isFinalLeadStatus('left')).toBe(true)
    expect(isFinalLeadStatus('ignore')).toBe(false)
    expect(isFinalLeadStatus('awaiting_exit')).toBe(false)
    expect(isFinalLeadStatus(null)).toBe(false)
    expect(isFinalLeadStatus(undefined)).toBe(false)
  })
})

describe('leadNeedsDailyStatus', () => {
  const today = mskDayKey(AFTER_DEADLINE)

  it('нефинальный лид без подтверждения требует статус', () => {
    expect(
      leadNeedsDailyStatus(
        { status: 'ignore', statusConfirmedDate: null },
        AFTER_DEADLINE,
      ),
    ).toBe(true)
  })

  it('нефинальный лид, подтверждённый сегодня, не требует', () => {
    expect(
      leadNeedsDailyStatus(
        { status: 'ignore', statusConfirmedDate: today },
        AFTER_DEADLINE,
      ),
    ).toBe(false)
  })

  it('финальный лид освобождён от гейта даже без подтверждения', () => {
    for (const status of FINAL_LEAD_STATUSES) {
      expect(
        leadNeedsDailyStatus(
          { status, statusConfirmedDate: null },
          AFTER_DEADLINE,
        ),
      ).toBe(false)
      expect(
        leadNeedsDailyStatus(
          { status, statusConfirmedDate: '2020-01-01' },
          AFTER_DEADLINE,
        ),
      ).toBe(false)
    }
  })

  it('совпадает с needsDailyStatusUpdate для нефинальных', () => {
    for (const date of [null, '2020-01-01', today]) {
      for (const now of [BEFORE_DEADLINE, AFTER_DEADLINE]) {
        expect(
          leadNeedsDailyStatus(
            { status: 'in_progress', statusConfirmedDate: date },
            now,
          ),
        ).toBe(needsDailyStatusUpdate(date, now))
      }
    }
  })
})
