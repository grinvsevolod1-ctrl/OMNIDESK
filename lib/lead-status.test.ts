import { describe, expect, it } from 'vitest'
import {
  FINAL_LEAD_STATUSES,
  isFinalLeadStatus,
  isReworkStatus,
  leadNeedsDailyStatus,
  needsDailyStatusUpdate,
  REWORK_LEAD_STATUSES,
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

describe('isReworkStatus (возврат лида менеджеру в «Доработки»)', () => {
  it('только Игнор / Отказался / Не связался попадают в набор', () => {
    expect(REWORK_LEAD_STATUSES).toEqual(['no_contact', 'refused', 'ignore'])
    expect(isReworkStatus('no_contact')).toBe(true)
    expect(isReworkStatus('refused')).toBe(true)
    expect(isReworkStatus('ignore')).toBe(true)
  })

  it('рабочие и прочие статусы в «Доработки» не возвращаются', () => {
    // «Кинул» сознательно НЕ в наборе (владелец не отметил его в чекбоксах).
    expect(isReworkStatus('left')).toBe(false)
    expect(isReworkStatus('working')).toBe(false)
    expect(isReworkStatus('new')).toBe(false)
    expect(isReworkStatus('training')).toBe(false)
    expect(isReworkStatus(null)).toBe(false)
    expect(isReworkStatus(undefined)).toBe(false)
    expect(isReworkStatus('')).toBe(false)
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
