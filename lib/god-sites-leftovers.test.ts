import { describe, expect, it } from 'vitest'
import { sanitizeState } from './god-sites-validation'
import {
  applyAutoSpendSave,
  rolloverAutoSpend,
  stateForPeriod,
} from './god-sites-projection'
import type { SiteState } from './god-sites-types'

const A = {
  id: '111',
  name: 'A',
  status: 'running' as const,
  cost: 50,
  shows: 500,
  clicks: 50,
  goals: 5,
  revenue: 100,
  bounce: 20,
  weeklyBudget: 700,
}

const evening = new Date('2026-08-13T17:30:00Z')
const nextNoon = new Date('2026-08-14T09:00:00Z')

function ledgerSite(): SiteState {
  const prev = sanitizeState({
    login: 'x',
    balance: 5000,
    currency: '$',
    campaigns: [A],
    autoSpend: {
      enabled: true,
      dailyBudget: 100,
      tzOffsetHours: 3,
      startDay: '2026-08-01',
      lastCommittedDay: '2026-08-13',
      spentToDate: 1200,
    },
  })
  const next = sanitizeState({ ...prev, autoSpend: { ...prev.autoSpend, dailyBudget: 120 } })
  const saved = applyAutoSpendSave(next, prev, evening)
  return rolloverAutoSpend(saved, nextNoon) ?? saved
}

const cost = (s: SiteState, p: 'yesterday' | 'week' | 'month' | 'all') =>
  stateForPeriod(s, p, nextNoon).campaigns[0].cost

describe('«Вчера» override folds into the frozen day', () => {
  it('shows the same yesterday, carries into week/month/all, keeps balance', () => {
    const prev = ledgerSite()
    expect(prev.autoSpend?.days?.['2026-08-13']).toBeTruthy()
    const y0 = cost(prev, 'yesterday')
    const w0 = cost(prev, 'week')
    const a0 = cost(prev, 'all')
    const bal0 = stateForPeriod(prev, 'today', nextNoon).balance

    const next = sanitizeState({
      ...prev,
      periodOverrides: { yesterday: { '111': { cost: y0 + 40 } } },
    })
    const saved = applyAutoSpendSave(next, prev, nextNoon)

    expect(saved.periodOverrides?.yesterday).toBeUndefined()
    expect(cost(saved, 'yesterday')).toBeCloseTo(y0 + 40, 2)
    expect(cost(saved, 'week')).toBeCloseTo(w0 + 40, 2)
    expect(cost(saved, 'all')).toBeCloseTo(a0 + 40, 2)
    expect(stateForPeriod(saved, 'today', nextNoon).balance).toBeCloseTo(bal0, 2)
  })

  it('an untouched existing override stays a display overlay (nothing shifts)', () => {
    const base = ledgerSite()
    const withOv = { ...base, periodOverrides: { yesterday: { '111': { cost: 7 } } } }
    const before = ['yesterday', 'week', 'all'].map((p) =>
      cost(withOv, p as 'yesterday'),
    )
    const saved = applyAutoSpendSave(sanitizeState({ ...withOv }), withOv, nextNoon)
    expect(saved.periodOverrides?.yesterday?.['111']?.cost).toBe(7)
    const after = ['yesterday', 'week', 'all'].map((p) => cost(saved, p as 'yesterday'))
    expect(after).toEqual(before)
  })
})

describe('budget 0 keeps history', () => {
  it('setting budget to 0 and back does not wipe «Всё время»', () => {
    const prev = ledgerSite()
    const all0 = cost(prev, 'all')
    const zero = applyAutoSpendSave(
      sanitizeState({ ...prev, autoSpend: { ...prev.autoSpend!, dailyBudget: 0 } }),
      prev,
      nextNoon,
    )
    expect(cost(zero, 'all')).toBeGreaterThanOrEqual(all0 - 0.01)
    const back = applyAutoSpendSave(
      sanitizeState({ ...zero, autoSpend: { ...zero.autoSpend!, dailyBudget: 120 } }),
      zero,
      nextNoon,
    )
    expect(back.autoSpend?.historyFrom).toBe(prev.autoSpend?.historyFrom)
    expect(cost(back, 'all')).toBeGreaterThanOrEqual(all0 - 0.01)
  })
})
