import { round2, SPEND_PROFILES, type SpendProfile } from './god-sites-sim'
import {
  PERIOD_METRIC_FIELDS,
  SITE_PERIODS,
  type PeriodOverride,
  type SiteCampaign,
  type SiteRecommendation,
  type SiteState,
} from './god-sites-types'

/**
 * Input sanitization for god-panel managed sites. Every value that reaches the
 * DB — hand-pasted JSON in the editor, or the seed passed to createSite — goes
 * through here first, so the stored `state` is always well-formed. Extracted
 * verbatim from god-sites.ts; re-exported from there for backwards compat.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only — same as god-sites.ts.
 */

export const MAX_CAMPAIGNS = 200
export const MAX_RECOMMENDATIONS = 50
export const MAX_STR = 300
export const MAX_NUM = 1_000_000_000

export function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return fallback
  return Math.min(n, MAX_NUM)
}

export function str(v: unknown, fallback = ''): string {
  if (typeof v !== 'string') return fallback
  return v.slice(0, MAX_STR)
}

/** Normalize arbitrary JSON into a well-formed SiteCampaign. */
export function sanitizeCampaign(
  raw: unknown,
  existing?: SiteCampaign,
): SiteCampaign {
  const r = (raw ?? {}) as Record<string, unknown>
  const base: SiteCampaign =
    existing ?? {
      id: '',
      name: '',
      status: 'stopped',
      cost: 0,
      shows: 0,
      clicks: 0,
      goals: 0,
      bounce: 0,
      revenue: 0,
      weeklyBudget: 0,
      strategy: '',
      platform: '',
      regions: '',
      type: '',
      startDate: '',
      endDate: '',
    }
  return {
    id: 'id' in r ? str(r.id, base.id) : base.id,
    name: 'name' in r ? str(r.name, base.name) : base.name,
    status:
      r.status === 'running' || r.status === 'stopped'
        ? r.status
        : base.status,
    cost: 'cost' in r ? num(r.cost, base.cost) : base.cost,
    shows: 'shows' in r ? Math.round(num(r.shows, base.shows)) : base.shows,
    clicks:
      'clicks' in r ? Math.round(num(r.clicks, base.clicks)) : base.clicks,
    goals: 'goals' in r ? Math.round(num(r.goals, base.goals)) : base.goals,
    bounce: 'bounce' in r ? Math.min(num(r.bounce, base.bounce), 100) : base.bounce,
    revenue: 'revenue' in r ? num(r.revenue, base.revenue) : base.revenue,
    weeklyBudget:
      'weeklyBudget' in r
        ? num(r.weeklyBudget, base.weeklyBudget)
        : base.weeklyBudget,
    strategy: 'strategy' in r ? str(r.strategy, base.strategy) : base.strategy,
    platform: 'platform' in r ? str(r.platform, base.platform) : base.platform,
    regions: 'regions' in r ? str(r.regions, base.regions) : base.regions,
    type: 'type' in r ? str(r.type, base.type) : base.type,
    startDate:
      'startDate' in r ? str(r.startDate, base.startDate) : base.startDate,
    endDate: 'endDate' in r ? str(r.endDate, base.endDate) : base.endDate,
  }
}

/** Normalize arbitrary JSON into a well-formed SiteState. */
export function sanitizeState(raw: unknown): SiteState {
  const r = (raw ?? {}) as Record<string, unknown>
  const campaigns = Array.isArray(r.campaigns)
    ? r.campaigns.slice(0, MAX_CAMPAIGNS).map((c) => sanitizeCampaign(c))
    : []
  const state: SiteState = {
    login: str(r.login).trim(),
    balance: num(r.balance),
    currency: str(r.currency, '$') || '$',
    // Organization card; `org`/`org_id`/`accountId` aliases are accepted on
    // input for hand-pasted JSON, canonical camelCase is what we store.
    organization: str(r.organization ?? (r as { org?: unknown }).org).trim(),
    phone: str(r.phone).trim(),
    orgId: str(
      r.orgId ??
        (r as { org_id?: unknown }).org_id ??
        (r as { accountId?: unknown }).accountId,
    ).trim(),
    campaigns,
  }
  if (Array.isArray(r.recommendations)) {
    const recs = r.recommendations
      .slice(0, MAX_RECOMMENDATIONS)
      .map((raw, i): SiteRecommendation => {
        const rec = (raw ?? {}) as Record<string, unknown>
        return {
          id: str(rec.id).trim() || `r${i + 1}`,
          title: str(rec.title).trim(),
          // Contract accepts `text` or `description` — store as `text`.
          text: str(rec.text ?? rec.description).trim(),
          category: str(rec.category).trim(),
          campaign: str(rec.campaign).trim(),
          impact: str(rec.impact).trim(),
        }
      })
      .filter((rec) => rec.title || rec.text)
    if (recs.length > 0) state.recommendations = recs
  }
  if (r.periodOverrides && typeof r.periodOverrides === 'object') {
    const out: NonNullable<SiteState['periodOverrides']> = {}
    for (const p of SITE_PERIODS) {
      // `today` overrides are never applied by stateForPeriod (today is always
      // the live view) — drop them instead of storing dead data.
      if (p === 'today') continue
      const perPeriod = (r.periodOverrides as Record<string, unknown>)[p]
      if (!perPeriod || typeof perPeriod !== 'object') continue
      const byId: Record<string, PeriodOverride> = {}
      for (const [cid, ov] of Object.entries(
        perPeriod as Record<string, unknown>,
      )) {
        if (!ov || typeof ov !== 'object') continue
        const clean: PeriodOverride = {}
        for (const f of PERIOD_METRIC_FIELDS) {
          if (f in (ov as Record<string, unknown>)) {
            clean[f] = num((ov as Record<string, unknown>)[f])
          }
        }
        if (Object.keys(clean).length > 0) byId[str(cid)] = clean
      }
      if (Object.keys(byId).length > 0) out[p] = byId
    }
    if (Object.keys(out).length > 0) state.periodOverrides = out
  }
  if (r.autoSpend && typeof r.autoSpend === 'object') {
    const a = r.autoSpend as Record<string, unknown>
    const dailyBudget = num(a.dailyBudget)
    const lastCommittedDay = str(a.lastCommittedDay).trim()
    const startDay = str(a.startDay).trim()
    const tz = typeof a.tzOffsetHours === 'number' ? a.tzOffsetHours : 3
    const clamp01 = (v: unknown, max: number) =>
      Math.max(0, Math.min(max, num(v)))
    state.autoSpend = {
      enabled: a.enabled === true && dailyBudget > 0,
      dailyBudget,
      ...(/^\d{4}-\d{2}-\d{2}$/.test(lastCommittedDay)
        ? { lastCommittedDay }
        : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(startDay) ? { startDay } : {}),
      ...(a.spentToDate !== undefined
        ? { spentToDate: round2(num(a.spentToDate)) }
        : {}),
      tzOffsetHours: Math.max(-12, Math.min(14, Math.trunc(tz))),
      // Curve settings — kept ONLY when explicitly set, so legacy states
      // stay byte-identical after a sanitize round-trip.
      ...(typeof a.profile === 'string' && a.profile in SPEND_PROFILES
        ? { profile: a.profile as SpendProfile }
        : {}),
      ...(a.smoothness !== undefined
        ? { smoothness: clamp01(a.smoothness, 1) }
        : {}),
      ...(a.weekendDip !== undefined
        ? { weekendDip: clamp01(a.weekendDip, 0.5) }
        : {}),
      ...(a.dayJitter !== undefined
        ? { dayJitter: clamp01(a.dayJitter, 0.2) }
        : {}),
    }
  }
  return state
}
