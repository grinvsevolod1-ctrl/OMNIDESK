import { describe, expect, it } from 'vitest'
import { sanitizeState } from './god-sites-validation'
import {
  applyAutoSpendSave,
  resolveAllTimeEntries,
  rolloverAutoSpend,
  setAllTimeBaseline,
  SiteSaveInvalid,
  stateForPeriod,
} from './god-sites-projection'
import type { SitePeriod, SiteState } from './god-sites-types'

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
const B = { ...A, id: '222', name: 'B' }

const evening = new Date('2026-08-13T17:30:00Z') // 20:30 MSK

/** A ledger-mode site with ~40 days of history. */
function ledgerSite(): SiteState {
  const legacy = sanitizeState({
    login: 'x',
    balance: 50000,
    currency: '$',
    campaigns: [A, B],
    autoSpend: {
      enabled: true,
      dailyBudget: 100,
      tzOffsetHours: 3,
      startDay: '2026-07-01',
      lastCommittedDay: '2026-08-12',
      spentToDate: 4000,
    },
  })
  return rolloverAutoSpend(legacy, evening) as SiteState
}

function shown(s: SiteState, p: SitePeriod, id = '111') {
  return stateForPeriod(s, p, evening).campaigns.find((c) => c.id === id)!
}

function withOverride(s: SiteState, p: SitePeriod, ov: Record<string, number>): SiteState {
  return sanitizeState({
    ...s,
    periodOverrides: { ...(s.periodOverrides ?? {}), [p]: { '111': ov } },
  })
}

describe('consistent period edits', () => {
  it('week cost → week exact, ratios kept, yesterday/today untouched, month and all follow', () => {
    const s0 = ledgerSite()
    const before = {
      today: shown(s0, 'today'),
      yesterday: shown(s0, 'yesterday'),
      week: shown(s0, 'week'),
      month: shown(s0, 'month'),
      all: shown(s0, 'all'),
    }
    const target = before.week.cost + 400
    const s1 = applyAutoSpendSave(withOverride(s0, 'week', { cost: target }), s0, evening)

    expect(s1.periodOverrides?.week).toBeUndefined() // folded into history
    const week = shown(s1, 'week')
    expect(week.cost).toBeCloseTo(target, 2)
    // shows/clicks scaled with cost → CPM/CPC roughly the same
    expect(week.shows / week.cost).toBeCloseTo(before.week.shows / before.week.cost, 0)
    expect(shown(s1, 'today')).toEqual(before.today)
    expect(shown(s1, 'yesterday')).toEqual(before.yesterday)
    expect(shown(s1, 'month').cost).toBeCloseTo(before.month.cost + 400, 1)
    expect(shown(s1, 'all').cost).toBeCloseTo(before.all.cost + 400, 1)
    // other campaign untouched
    expect(shown(s1, 'week', '222')).toEqual(shown(s0, 'week', '222'))
    // balance (real money) never rewritten retroactively
    expect(s1.balance).toBe(s0.balance)
  })

  it('month edit keeps the week as shown', () => {
    const s0 = ledgerSite()
    const week = shown(s0, 'week')
    const target = shown(s0, 'month').cost * 2
    const s1 = applyAutoSpendSave(withOverride(s0, 'month', { cost: target }), s0, evening)
    expect(shown(s1, 'week')).toEqual(week)
    expect(shown(s1, 'month').cost).toBeCloseTo(target, 2)
  })

  it('week + month + yesterday in one save all land exactly', () => {
    const s0 = ledgerSite()
    const s1 = applyAutoSpendSave(
      sanitizeState({
        ...s0,
        periodOverrides: {
          yesterday: { '111': { cost: 80 } },
          week: { '111': { cost: 600 } },
          month: { '111': { cost: 2500 } },
        },
      }),
      s0,
      evening,
    )
    expect(shown(s1, 'yesterday').cost).toBeCloseTo(80, 2)
    expect(shown(s1, 'week').cost).toBeCloseTo(600, 2)
    expect(shown(s1, 'month').cost).toBeCloseTo(2500, 2)
  })

  it('rejects a week smaller than yesterday + today', () => {
    const s0 = ledgerSite()
    expect(() =>
      applyAutoSpendSave(withOverride(s0, 'week', { cost: 1 }), s0, evening),
    ).toThrow(SiteSaveInvalid)
  })

  it('unchanged overrides are not re-folded (nothing moves on a plain save)', () => {
    const s0 = ledgerSite()
    const s1 = applyAutoSpendSave(withOverride(s0, 'week', { cost: 900 }), s0, evening)
    const s2 = applyAutoSpendSave(sanitizeState({ ...s1 }), s1, evening)
    expect(stateForPeriod(s2, 'week', evening)).toEqual(stateForPeriod(s1, 'week', evening))
  })
})

describe('all-time consistency', () => {
  it('3000 all-time → shows/clicks/goals/revenue follow, month floor enforced', () => {
    const s0 = ledgerSite()
    const cur = shown(s0, 'all')
    const s1 = setAllTimeBaseline(s0, { '111': { cost: 3000 } }, evening) as SiteState
    const all = shown(s1, 'all')
    expect(all.cost).toBe(3000)
    const k = 3000 / cur.cost
    expect(all.clicks).toBe(Math.round(cur.clicks * k))
    expect(all.goals).toBe(Math.round(cur.goals * k))
    expect(all.revenue).toBeCloseTo(cur.revenue * k, 0)
    expect(all.clicks).toBeGreaterThanOrEqual(shown(s1, 'month').clicks)
  })

  it('all-time below month is refused with a clear message', () => {
    const s0 = ledgerSite()
    const month = shown(s0, 'month').cost
    const res = setAllTimeBaseline(s0, { '111': { cost: month - 10 } }, evening)
    expect('invalid' in res).toBe(true)
    expect(resolveAllTimeEntries(s0, { '111': { cost: month - 10 } }, evening).errors['111']).toMatch(
      /не может быть меньше/,
    )
  })

  it('a later week correction moves all-time by the same delta', () => {
    const s0 = ledgerSite()
    const s1 = setAllTimeBaseline(s0, { '111': { cost: 5000 } }, evening) as SiteState
    const w = shown(s1, 'week').cost
    const s2 = applyAutoSpendSave(withOverride(s1, 'week', { cost: w - 50 }), s1, evening)
    expect(shown(s2, 'all').cost).toBeCloseTo(4950, 1)
  })
})
