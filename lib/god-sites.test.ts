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
    const week = stateForPeriod(state, 'week', 3)
    expect(week.campaigns[0].cost).toBe(777)
    expect(week.revision).toBe(3)
    // Base state untouched.
    expect(state.campaigns[0].cost).toBe(100)
  })

  it('today always shows the canonical (live-editable) numbers', () => {
    const today = stateForPeriod(state, 'today', 3)
    expect(today.campaigns[0].cost).toBe(100)
  })

  it('never leaks periodOverrides to the page payload', () => {
    const out = stateForPeriod(state, 'week', 1) as unknown as Record<
      string,
      unknown
    >
    expect(out.periodOverrides).toBeUndefined()
  })
})

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
