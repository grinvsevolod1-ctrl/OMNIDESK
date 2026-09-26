import { describe, expect, it } from 'vitest'
import { sanitizeState } from './god-sites-validation'
import {
  applyAutoSpendSave,
  freezeToday,
  liveBalance,
  rolloverAutoSpend,
  stateForPeriod,
} from './god-sites-projection'
import type { SiteState, SitePeriod } from './god-sites-types'

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

const PERIODS: SitePeriod[] = ['today', 'yesterday', 'week', 'month', 'all']

function legacy(): SiteState {
  return sanitizeState({
    login: 'x',
    balance: 5000,
    currency: '$',
    campaigns: [A, B],
    autoSpend: {
      enabled: true,
      dailyBudget: 100,
      tzOffsetHours: 3,
      startDay: '2026-07-01',
      lastCommittedDay: '2026-08-13',
      spentToDate: 4000,
    },
  })
}

const evening = new Date('2026-08-13T17:30:00Z') // 20:30 MSK

function snapshot(s: SiteState, now: Date) {
  return PERIODS.map((p) => stateForPeriod(s, p, now))
}

function costs(s: SiteState, p: SitePeriod, now: Date) {
  return stateForPeriod(s, p, now).campaigns.map((c) => c.cost)
}

describe('frozen ledger', () => {
  it('switching legacy → ledger on a save does not move any shown number', () => {
    const prev = legacy()
    const before = snapshot(prev, evening)
    // A relevant change: budget up. Numbers already shown must not move.
    const next = sanitizeState({
      ...prev,
      autoSpend: { ...prev.autoSpend, dailyBudget: 300 },
    })
    const saved = applyAutoSpendSave(next, prev, evening)
    expect(saved.autoSpend?.historyFrom).toBeTruthy()
    const after = snapshot(saved, evening)
    for (let i = 0; i < PERIODS.length; i++) {
      after[i].campaigns.forEach((c, j) => {
        expect(c.cost).toBeCloseTo(before[i].campaigns[j].cost, 1)
      })
      expect(after[i].balance).toBeCloseTo(before[i].balance, 1)
    }
  })

  it('a budget change never rewrites yesterday / past days', () => {
    const prev = legacy()
    const y = costs(prev, 'yesterday', evening)
    const next = sanitizeState({
      ...prev,
      autoSpend: { ...prev.autoSpend, dailyBudget: 1000 },
    })
    const saved = applyAutoSpendSave(next, prev, evening)
    const later = new Date(evening.getTime() + 60 * 60 * 1000)
    expect(costs(saved, 'yesterday', later)).toEqual(y)
    // Today grows faster from now on, but never drops below what was shown.
    const t0 = costs(prev, 'today', evening)
    costs(saved, 'today', later).forEach((c, i) =>
      expect(c).toBeGreaterThanOrEqual(t0[i]),
    )
  })

  it('disabling keeps today and history; balance is not refunded', () => {
    const prev = legacy()
    const before = snapshot(prev, evening)
    const next = sanitizeState({
      ...prev,
      autoSpend: { ...prev.autoSpend, enabled: false },
    })
    const saved = applyAutoSpendSave(next, prev, evening)
    const later = new Date(evening.getTime() + 2 * 60 * 60 * 1000)
    const after = snapshot(saved, later)
    for (let i = 0; i < PERIODS.length; i++) {
      after[i].campaigns.forEach((c, j) =>
        expect(c.cost).toBeCloseTo(before[i].campaigns[j].cost, 1),
      )
    }
    expect(liveBalance(saved, later)).toBeCloseTo(before[0].balance, 1)
    // Next day: the banked partial becomes «Вчера».
    const tomorrow = new Date('2026-08-14T12:00:00Z')
    const rolled = rolloverAutoSpend(saved, tomorrow) ?? saved
    costs(rolled, 'yesterday', tomorrow).forEach((c, j) =>
      expect(c).toBeCloseTo(before[0].campaigns[j].cost, 1),
    )
  })

  it('re-enabling resumes: history survives, no instant catch-up burn', () => {
    const prev = legacy()
    const off = applyAutoSpendSave(
      sanitizeState({ ...prev, autoSpend: { ...prev.autoSpend, enabled: false } }),
      prev,
      evening,
    )
    const shownToday = costs(off, 'today', evening)
    const weekOff = costs(off, 'week', evening)
    const later = new Date(evening.getTime() + 60 * 60 * 1000)
    const on = applyAutoSpendSave(
      sanitizeState({ ...off, autoSpend: { ...off.autoSpend, enabled: true } }),
      off,
      later,
    )
    expect(on.autoSpend?.startDay).toBe('2026-07-01')
    expect(costs(on, 'today', later)).toEqual(shownToday)
    expect(costs(on, 'week', later)).toEqual(weekOff)
  })

  it('stopping a campaign stops its spend and does not boost the others', () => {
    const prev = legacy()
    const tA = costs(prev, 'today', evening)
    const next = sanitizeState({
      ...prev,
      campaigns: [A, { ...B, status: 'stopped' }],
    })
    const saved = applyAutoSpendSave(next, prev, evening)
    const later = new Date('2026-08-13T20:30:00Z') // 23:30 MSK
    const out = stateForPeriod(saved, 'today', later)
    // Stopped B is frozen at what it had burnt by the stop.
    expect(out.campaigns[1].cost).toBeCloseTo(tA[1], 1)
    // A keeps burning only its own share (≈ half the budget), not all 100.
    expect(out.campaigns[0].cost).toBeLessThan(62)
  })

  it('top-up at zero balance does not catch up the whole day instantly', () => {
    const broke = sanitizeState({ ...legacy(), balance: 0 })
    const beforeToday = costs(broke, 'today', evening)
    const s = freezeToday(broke, evening)
    const topped = { ...s, balance: s.balance + 1000 }
    expect(costs(topped, 'today', evening)).toEqual(beforeToday)
  })

  it('TZ moved back never re-opens a committed day (no double charge)', () => {
    const prev = legacy()
    const rolledTomorrow = rolloverAutoSpend(prev, new Date('2026-08-13T21:30:00Z'))!
    expect(rolledTomorrow.autoSpend?.lastCommittedDay).toBe('2026-08-14')
    const back = sanitizeState({
      ...rolledTomorrow,
      autoSpend: { ...rolledTomorrow.autoSpend, tzOffsetHours: -5 },
    })
    const saved = applyAutoSpendSave(back, rolledTomorrow, new Date('2026-08-13T21:40:00Z'))
    expect(rolloverAutoSpend(saved, new Date('2026-08-13T22:00:00Z'))).toBeNull()
    expect(saved.balance).toBeLessThanOrEqual(rolledTomorrow.balance)
  })

  it('ledger survives a sanitize round-trip (DB → editor → save)', () => {
    const prev = legacy()
    const saved = applyAutoSpendSave(
      sanitizeState({ ...prev, autoSpend: { ...prev.autoSpend, dailyBudget: 200 } }),
      prev,
      evening,
    )
    expect(sanitizeState(saved)).toEqual(saved)
  })
})

describe('all-time baseline', () => {
  it('typed total becomes the truth; later spend adds on top; other periods untouched', async () => {
    const { setAllTimeBaseline } = await import('./god-sites-projection')
    const s0 = legacy()
    const before = snapshot(s0, evening)
    const s1 = setAllTimeBaseline(s0, { '111': { cost: 12345 } }, evening)
    const after = snapshot(s1, evening)
    // today/yesterday/week/month identical
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4))
    const all = stateForPeriod(s1, 'all', evening).campaigns
    expect(all.find((c) => c.id === '111')!.cost).toBe(12345)
    // untouched campaign and untouched fields keep what was shown
    expect(all.find((c) => c.id === '222')).toEqual(
      before[4].campaigns.find((c) => c.id === '222'),
    )
    expect(all.find((c) => c.id === '111')!.shows).toBe(
      before[4].campaigns.find((c) => c.id === '111')!.shows,
    )
    expect(liveBalance(s1, evening)).toBe(liveBalance(s0, evening))
    // next day: all-time grows by exactly what the ledger adds
    const later = new Date('2026-08-14T17:30:00Z')
    const noBase: SiteState = {
      ...s1,
      autoSpend: { ...s1.autoSpend!, allTime: undefined },
    }
    const rawDelta =
      costs(noBase, 'all', later)[0] - costs(noBase, 'all', evening)[0]
    const shownLater = stateForPeriod(s1, 'all', later).campaigns.find(
      (c) => c.id === '111',
    )!.cost
    expect(shownLater).toBeCloseTo(12345 + rawDelta, 1)
    expect(shownLater).toBeGreaterThan(12345)
  })

  it('survives sanitize round-trip', async () => {
    const { setAllTimeBaseline } = await import('./god-sites-projection')
    const s1 = setAllTimeBaseline(legacy(), { '111': { cost: 999 } }, evening)
    const s2 = sanitizeState(JSON.parse(JSON.stringify(s1)))
    expect(stateForPeriod(s2, 'all', evening)).toEqual(
      stateForPeriod(s1, 'all', evening),
    )
  })
})
