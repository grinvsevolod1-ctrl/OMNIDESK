import { describe, expect, it } from 'vitest'
import {
  hashApiKey,
  normalizePeriod,
  sanitizeCampaign,
  sanitizeState,
  stateForPeriod,
  type SiteCampaign,
} from './god-sites'

const CAMPAIGN: SiteCampaign = {
  id: '123456789',
  name: 'Тест',
  status: 'running',
  cost: 100,
  shows: 1000,
  clicks: 50,
  goals: 5,
  bounce: 12.5,
  revenue: 250,
  weeklyBudget: 700,
  strategy: 'Максимум кликов',
  platform: 'Поиск',
  regions: 'Москва',
  type: 'Текстово-графические',
  startDate: '2026-01-01',
  endDate: '',
}

describe('sanitizeState', () => {
  it('normalizes malformed JSON into a well-formed state', () => {
    const s = sanitizeState({
      balance: '150.5',
      currency: '₽',
      campaigns: [{ id: 1, name: 42, status: 'bogus', cost: -5, bounce: 250 }],
    })
    expect(s.balance).toBe(150.5)
    expect(s.currency).toBe('₽')
    expect(s.campaigns).toHaveLength(1)
    const c = s.campaigns[0]
    // Non-string id/name fall back to defaults, not to garbage.
    expect(c.id).toBe('')
    expect(c.name).toBe('')
    expect(c.status).toBe('stopped')
    expect(c.cost).toBe(0) // negative rejected
    expect(c.bounce).toBeLessThanOrEqual(100)
  })

  it('defaults to an empty cabinet for junk input', () => {
    for (const junk of [null, undefined, 'str', 42, []]) {
      const s = sanitizeState(junk)
      expect(s.balance).toBe(0)
      expect(s.campaigns).toEqual([])
      expect(s.currency).toBeTruthy()
    }
  })

  it('keeps only known metric fields in periodOverrides', () => {
    const s = sanitizeState({
      balance: 1,
      campaigns: [CAMPAIGN],
      periodOverrides: {
        week: { [CAMPAIGN.id]: { cost: 999, evil: 'x', shows: 1 } },
        bogusPeriod: { [CAMPAIGN.id]: { cost: 1 } },
      },
    })
    const ov = s.periodOverrides?.week?.[CAMPAIGN.id]
    expect(ov).toEqual({ cost: 999, shows: 1 })
    expect(
      (s.periodOverrides as Record<string, unknown> | undefined)?.bogusPeriod,
    ).toBeUndefined()
  })
})

describe('sanitizeCampaign patch semantics', () => {
  it('only touches fields present in the patch', () => {
    const patched = sanitizeCampaign({ cost: 200 }, CAMPAIGN)
    expect(patched.cost).toBe(200)
    expect(patched.name).toBe(CAMPAIGN.name)
    expect(patched.status).toBe(CAMPAIGN.status)
  })

  it('rejects invalid values in a patch, keeping the existing ones', () => {
    const patched = sanitizeCampaign(
      { cost: -1, status: 'exploded', name: 7 },
      CAMPAIGN,
    )
    expect(patched.cost).toBe(CAMPAIGN.cost)
    expect(patched.status).toBe(CAMPAIGN.status)
    expect(patched.name).toBe(CAMPAIGN.name)
  })
})

describe('stateForPeriod', () => {
  const state = sanitizeState({
    balance: 500,
    currency: '$',
    campaigns: [CAMPAIGN],
    periodOverrides: { week: { [CAMPAIGN.id]: { cost: 777 } } },
  })

  it('applies per-period overlays without mutating the base', () => {
    const week = stateForPeriod(state, 'week')
    expect(week.campaigns[0].cost).toBe(777)
    expect(week.period).toBe('week')
    // Base state untouched.
    expect(state.campaigns[0].cost).toBe(100)
  })

  it('today always shows the canonical (live-editable) numbers', () => {
    const today = stateForPeriod(state, 'today')
    expect(today.campaigns[0].cost).toBe(100)
  })

  it('exposes nothing beyond the contract State (no overrides, no revision)', () => {
    const out = stateForPeriod(state, 'week') as unknown as Record<
      string,
      unknown
    >
    expect(out.periodOverrides).toBeUndefined()
    expect(out.revision).toBeUndefined()
    expect(Object.keys(out).sort()).toEqual([
      'balance',
      'campaigns',
      'currency',
      'login',
      'period',
    ])
  })

  it('carries the cabinet login through to the page payload', () => {
    const withLogin = sanitizeState({
      login: '  direct-pro-001  ',
      balance: 1,
      campaigns: [],
    })
    expect(stateForPeriod(withLogin, 'today').login).toBe('direct-pro-001')
    // Absent login degrades to an empty string, never undefined.
    expect(stateForPeriod(state, 'today').login).toBe('')
  })
})

describe('auto-spend projection', () => {
  const autoState = sanitizeState({
    login: 'auto-cab',
    balance: 1000,
    currency: '$',
    campaigns: [
      CAMPAIGN,
      { ...CAMPAIGN, id: '987654321', name: 'Стоп', status: 'stopped' },
    ],
    autoSpend: { enabled: true, dailyBudget: 100, tzOffsetHours: 3 },
  })
  // 20:30 Moscow time — most of the day's curve is behind.
  const evening = new Date('2026-08-13T17:30:00Z')
  const night = new Date('2026-08-13T00:30:00Z') // 03:30 MSK

  it('sanitizes the config and disables it without a budget', () => {
    expect(autoState.autoSpend?.enabled).toBe(true)
    const noBudget = sanitizeState({
      balance: 1,
      campaigns: [],
      autoSpend: { enabled: true, dailyBudget: 0 },
    })
    expect(noBudget.autoSpend?.enabled).toBe(false)
  })

  it('burns spend deterministically and monotonically through the day', () => {
    const early = stateForPeriod(autoState, 'today', night)
    const late = stateForPeriod(autoState, 'today', evening)
    const again = stateForPeriod(autoState, 'today', evening)
    expect(late.campaigns[0].cost).toBeGreaterThan(early.campaigns[0].cost)
    expect(again).toEqual(late) // pure function of (state, now)
    expect(late.campaigns[0].cost).toBeLessThanOrEqual(100)
    expect(late.balance).toBeLessThan(1000)
    expect(round2(1000 - late.balance)).toBeCloseTo(
      round2(late.campaigns[0].cost),
      1,
    )
  })

  it('never touches stopped campaigns and scales metrics from the profile', () => {
    const out = stateForPeriod(autoState, 'today', evening)
    const stopped = out.campaigns.find((c) => c.id === '987654321')
    expect(stopped?.cost).toBe(CAMPAIGN.cost)
    const live = out.campaigns.find((c) => c.id === CAMPAIGN.id)
    // shows/clicks scale roughly with the base per-$ ratios (10 shows/$).
    expect(live!.shows / Math.max(live!.cost, 0.01)).toBeGreaterThan(5)
    expect(live!.revenue).toBeGreaterThan(0)
  })

  it('yesterday shows the finished day at full budget', () => {
    const y = stateForPeriod(autoState, 'yesterday', evening)
    const live = y.campaigns.find((c) => c.id === CAMPAIGN.id)!
    expect(live.cost).toBeGreaterThan(80) // ~dailyBudget minus jitter share
    expect(live.cost).toBeLessThanOrEqual(100)
    expect(y.balance).toBe(1000) // committed already — untouched
  })

  it('never exposes autoSpend to the page payload', () => {
    const out = stateForPeriod(autoState, 'today', evening) as unknown as Record<
      string,
      unknown
    >
    expect(out.autoSpend).toBeUndefined()
  })

  it('never spends below zero balance', () => {
    const broke = sanitizeState({
      balance: 5,
      campaigns: [CAMPAIGN],
      autoSpend: { enabled: true, dailyBudget: 100, tzOffsetHours: 3 },
    })
    const out = stateForPeriod(broke, 'today', evening)
    expect(out.balance).toBeGreaterThanOrEqual(0)
    expect(out.campaigns[0].cost).toBeLessThanOrEqual(5)
  })

  it('aggregates week/month as sums of per-day simulations', () => {
    const today = stateForPeriod(autoState, 'today', evening)
    const week = stateForPeriod(autoState, 'week', evening)
    const month = stateForPeriod(autoState, 'month', evening)
    const live = (p: typeof today) =>
      p.campaigns.find((c) => c.id === CAMPAIGN.id)!
    // Aggregates dwarf a single day and nest: today < week < month.
    expect(live(week).cost).toBeGreaterThan(live(today).cost)
    expect(live(month).cost).toBeGreaterThan(live(week).cost)
    // ~6 finished days at dailyBudget plus today's partial (± jitter).
    expect(live(week).cost).toBeGreaterThan(400)
    expect(live(week).cost).toBeLessThan(720)
    // Deterministic: same inputs, same aggregate.
    expect(stateForPeriod(autoState, 'week', evening)).toEqual(week)
    // Stopped campaigns keep their hand-edited numbers in aggregates too.
    const stopped = week.campaigns.find((c) => c.id === '987654321')
    expect(stopped?.cost).toBe(CAMPAIGN.cost)
    // Balance shows the live one — aggregate periods don't re-spend it.
    expect(week.balance).toBe(1000)
  })

  it('anchors «all» at autoSpend.startDay when present', () => {
    const anchored = sanitizeState({
      balance: 100000,
      campaigns: [CAMPAIGN],
      autoSpend: {
        enabled: true,
        dailyBudget: 100,
        tzOffsetHours: 3,
        startDay: '2026-06-13', // 61 days before `evening` (13 Aug)
      },
    })
    const all = stateForPeriod(anchored, 'all', evening)
    const month = stateForPeriod(anchored, 'month', evening)
    expect(all.campaigns[0].cost).toBeGreaterThan(month.campaigns[0].cost)
    // ~60 finished days + today's partial.
    expect(all.campaigns[0].cost).toBeGreaterThan(4500)
  })

  it('hand-curated overrides win over the aggregate simulation', () => {
    const curated = sanitizeState({
      balance: 1000,
      campaigns: [CAMPAIGN],
      autoSpend: { enabled: true, dailyBudget: 100, tzOffsetHours: 3 },
      periodOverrides: { week: { [CAMPAIGN.id]: { cost: 777 } } },
    })
    const week = stateForPeriod(curated, 'week', evening)
    expect(week.campaigns[0].cost).toBe(777) // override beats simulation
    expect(week.campaigns[0].shows).toBeGreaterThan(
      CAMPAIGN.shows, // non-overridden fields still come from the aggregate
    )
  })
})

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

describe('normalizePeriod / hashApiKey', () => {
  it('falls back to today for unknown periods', () => {
    expect(normalizePeriod('bogus')).toBe('today')
    expect(normalizePeriod(undefined)).toBe('today')
    expect(normalizePeriod('month')).toBe('month')
  })

  it('hashes are stable and never expose the key', () => {
    const h = hashApiKey('a'.repeat(48))
    expect(h).toHaveLength(64)
    expect(h).not.toContain('aaaa')
    expect(hashApiKey('a'.repeat(48))).toBe(h)
  })
})
