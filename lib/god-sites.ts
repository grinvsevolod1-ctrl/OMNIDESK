import 'server-only'

import { createHash, randomBytes } from 'crypto'
import { query } from './db'
import {
  autoDayFraction,
  autoDayKey,
  daysBetween,
  jitter,
  round2,
} from './god-sites-sim'

// Re-exported so existing consumers (tests, routes) keep importing the curve
// math from here; the implementation lives in god-sites-sim.ts (pure, shared
// with the god-panel editor preview).
export { autoDayFraction, autoDayKey } from './god-sites-sim'

/**
 * God-panel managed external sites ("управляемые сайты").
 *
 * Standalone HTML mockups (page3.html — кабинет «Директ Про») are hosted on a
 * separate domain and READ their data from OMNIDESK through
 * /api/ext/pages/{PAGE_ID}/* (contract in the mockup's API-INTEGRATION.md).
 * The page is a pure витрина: PAGE_ID (= slug here) identifies the page, the
 * Bearer token (= one-time API key) authenticates it, and no mutation ever
 * arrives from the page — ALL editing happens in the god-panel "Сайты" tab.
 * This module is the single data layer for both.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only. Never import this from
 * regular admin/manager/curator code or from lib/ai-console — enforced by
 * lib/ai/isolation.test.ts.
 *
 * Concurrency: god-panel editors use optimistic locking. Every save carries
 * the editor's known revision; the UPDATE is guarded by `WHERE revision = $n`,
 * so a stale save loses the race atomically (no read-modify-write window) and
 * the caller gets a 'conflict' instead of silently clobbering newer data.
 */

/* ------------------------------- Types --------------------------------- */

export const SITE_PERIODS = ['today', 'yesterday', 'week', 'month', 'all'] as const
export type SitePeriod = (typeof SITE_PERIODS)[number]

export interface SiteCampaign {
  id: string
  name: string
  status: 'running' | 'stopped'
  cost: number
  shows: number
  clicks: number
  goals: number
  bounce: number
  /** Revenue for the period — vitrine derives ДРР and ROI from it (§6). */
  revenue: number
  weeklyBudget: number
  strategy: string
  platform: string
  regions: string
  type: string
  startDate: string
  endDate: string
}

/** Metric fields that can be overridden per period (contract §3). */
export const PERIOD_METRIC_FIELDS = [
  'cost',
  'shows',
  'clicks',
  'goals',
  'bounce',
  'revenue',
] as const
export type PeriodMetricField = (typeof PERIOD_METRIC_FIELDS)[number]
export type PeriodOverride = Partial<Pick<SiteCampaign, PeriodMetricField>>

/**
 * Auto-spend ("авто-скрутка"): the panel burns `dailyBudget` per day all by
 * itself, following a natural intraday traffic curve. Internal to the god
 * panel — the vitrine only sees the resulting numbers, never this config.
 */
export interface AutoSpend {
  enabled: boolean
  /** How much to burn per day, in the site's currency. */
  dailyBudget: number
  /**
   * Day (YYYY-MM-DD in panel TZ) whose spend has already been committed to
   * the stored balance. Maintained by commitAutoSpend — not hand-edited.
   */
  lastCommittedDay?: string
  /**
   * Day (YYYY-MM-DD in panel TZ) auto-spend was first enabled — the anchor
   * for the «Всё время» period aggregate. Maintained by commitAutoSpend.
   */
  startDay?: string
  /** Day boundary timezone, hours east of UTC. Default +3 (Moscow). */
  tzOffsetHours?: number
}

/**
 * Recommendation card shown by the vitrine. All fields optional per the
 * contract; when the state carries none, the page computes its own — so an
 * empty list here means "auto", not "hide".
 */
export interface SiteRecommendation {
  id: string
  title: string
  text: string
  category: string
  /** Campaign NAME (free string per the contract example), '' = whole account. */
  campaign: string
  /** Free-form expected effect, e.g. «+15% конверсий». */
  impact: string
}

export interface SiteState {
  /** Cabinet login shown in the page header / side menu / tab title. */
  login: string
  balance: number
  currency: string
  /** Organization card (окно по клику на аватар): name, phone, account id. */
  organization: string
  phone: string
  orgId: string
  campaigns: SiteCampaign[]
  /**
   * Hand-curated recommendations. undefined/empty → NOT sent to the page,
   * which then computes them automatically (contract: field is optional).
   */
  recommendations?: SiteRecommendation[]
  /** Optional per-period metric overlays, god-panel curated. */
  periodOverrides?: Partial<Record<SitePeriod, Record<string, PeriodOverride>>>
  /** Auto-spend config — god-panel internal, never exposed to the page. */
  autoSpend?: AutoSpend
}

export interface GodSite {
  id: string
  slug: string
  title: string
  state: SiteState
  revision: number
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

export type MutationResult =
  | { ok: true; revision: number; state: SiteState }
  | { ok: false; error: 'conflict'; revision: number }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'invalid'; message: string }

/* ----------------------------- Validation ------------------------------ */

const MAX_CAMPAIGNS = 200
const MAX_RECOMMENDATIONS = 50
const MAX_STR = 300
const MAX_NUM = 1_000_000_000

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return fallback
  return Math.min(n, MAX_NUM)
}

function str(v: unknown, fallback = ''): string {
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
    state.autoSpend = {
      enabled: a.enabled === true && dailyBudget > 0,
      dailyBudget,
      ...(/^\d{4}-\d{2}-\d{2}$/.test(lastCommittedDay)
        ? { lastCommittedDay }
        : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(startDay) ? { startDay } : {}),
      tzOffsetHours: Math.max(-12, Math.min(14, Math.trunc(tz))),
    }
  }
  return state
}

export function normalizePeriod(v: unknown): SitePeriod {
  return SITE_PERIODS.includes(v as SitePeriod) ? (v as SitePeriod) : 'today'
}

/* ------------------------------ Key lookup ----------------------------- */

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Generate the one-time API key (shown once at creation). */
function generateApiKey(): string {
  return randomBytes(24).toString('hex')
}

interface SiteRow {
  id: string
  slug: string
  title: string
  state: unknown
  revision: number
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

function toSite(r: SiteRow): GodSite {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    state: sanitizeState(r.state),
    revision: Number(r.revision),
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * Resolve a site by its PAGE_ID (slug) AND plaintext API key in one shot.
 * The pair must match: a valid slug with a wrong token misses exactly like a
 * nonexistent slug — the API layer answers a bare 404 either way, so probing
 * cannot distinguish "page exists" from "page doesn't" (fail-closed, same
 * philosophy as the god gate). Also stamps last_seen_at ("жива ли страница").
 */
export async function getSiteBySlugAndKey(
  slug: string,
  key: string,
  opts?: { touch?: boolean },
): Promise<GodSite | null> {
  const s = (slug ?? '').trim().toLowerCase()
  if (!s || s.length > 60) return null
  if (!key || key.length < 16 || key.length > 128) return null
  const hash = hashApiKey(key)
  // Touch is throttled to once per 30s: pages poll every few seconds and SSE
  // re-resolves every 3s, so an unconditional UPDATE meant tens of thousands
  // of dead-row writes per page per day. The "на связи" indicator only needs
  // minute-level precision (isOnline window is 60s). The CTE keeps it one
  // round-trip: SELECT always answers, UPDATE fires only when stale.
  const rows = opts?.touch
    ? await query<SiteRow>(
        `WITH found AS (
           SELECT * FROM god_sites WHERE slug = $1 AND api_key_hash = $2
         ),
         touched AS (
           UPDATE god_sites SET last_seen_at = now()
            WHERE id IN (SELECT id FROM found)
              AND (last_seen_at IS NULL
                   OR last_seen_at < now() - interval '30 seconds')
         )
         SELECT * FROM found`,
        [s, hash],
      )
    : await query<SiteRow>(
        `SELECT * FROM god_sites WHERE slug = $1 AND api_key_hash = $2`,
        [s, hash],
      )
  return rows[0] ? toSite(rows[0]) : null
}

/* ------------------------------ Auto-spend ------------------------------ */

/*
 * Deterministic intraday burner. The projection is a PURE function of
 * (state, wall-clock time): every GET recomputes "how much has been spent by
 * now" from the daily budget and a natural traffic curve — no cron, no
 * background writers, and concurrent readers always agree. Numbers only ever
 * grow within a day (the curve is cumulative and per-day jitter is fixed), so
 * the vitrine sees a live cabinet that spends by itself. At day rollover the
 * finished day's budget is committed to the stored balance lazily, on the
 * first read of the new day (commitAutoSpend below).
 */

/** Fallback per-$ profile when a campaign has no base numbers to learn from. */
const DEFAULT_PROFILE = { shows: 320, clicks: 11, goals: 0.4, revenue: 0 }

/**
 * Simulate the auto-spend day: distribute `budget × fraction` across running
 * campaigns (weight = their base cost, else weekly budget, else equal) and
 * derive shows/clicks/goals/revenue from each campaign's own per-$ profile.
 * All jitter is seeded by (campaign, day) — stable within a day, fresh the
 * next. Stopped campaigns keep their hand-edited numbers untouched.
 */
function simulateAutoDay(
  state: SiteState,
  dayKey: string,
  fraction: number,
  budgetCap: number,
): { campaigns: SiteCampaign[]; totalSpent: number } {
  const cfg = state.autoSpend
  if (!cfg?.enabled || cfg.dailyBudget <= 0) {
    return { campaigns: state.campaigns, totalSpent: 0 }
  }
  const running = state.campaigns.filter((c) => c.status === 'running')
  if (running.length === 0) return { campaigns: state.campaigns, totalSpent: 0 }

  const totalSpent = round2(
    Math.min(cfg.dailyBudget * fraction, Math.max(0, budgetCap)),
  )

  // Budget shares: base cost → weekly budget → equal, jittered ±8% per day.
  const weights = running.map(
    (c) =>
      (c.cost > 0 ? c.cost : c.weeklyBudget > 0 ? c.weeklyBudget / 7 : 1) *
      jitter(`${dayKey}:${c.id}:w`, 0.08),
  )
  const weightSum = weights.reduce((a, b) => a + b, 0)

  const byId = new Map<string, SiteCampaign>()
  running.forEach((c, i) => {
    const spent = round2((totalSpent * weights[i]) / weightSum)
    // Per-$ profile from the campaign's own base numbers (its "shape").
    const perDollar =
      c.cost > 0
        ? {
            shows: c.shows / c.cost,
            clicks: c.clicks / c.cost,
            goals: c.goals / c.cost,
            revenue: c.revenue / c.cost,
          }
        : DEFAULT_PROFILE
    const m = (metric: keyof typeof perDollar, spread: number) =>
      spent * perDollar[metric] * jitter(`${dayKey}:${c.id}:${metric}`, spread)
    byId.set(c.id, {
      ...c,
      cost: spent,
      shows: Math.round(m('shows', 0.05)),
      clicks: Math.round(m('clicks', 0.05)),
      goals: Math.round(m('goals', 0.12)),
      revenue: round2(m('revenue', 0.1)),
      bounce: round2(
        Math.min(100, Math.max(0, c.bounce * jitter(`${dayKey}:${c.id}:b`, 0.06))),
      ),
    })
  })

  return {
    campaigns: state.campaigns.map((c) => byId.get(c.id) ?? c),
    totalSpent,
  }
}

/**
 * Lazily commit finished auto-spend days into the stored balance. Called on
 * page reads; the revision-guarded UPDATE makes concurrent first-reads of a
 * new day race safely — exactly one commits, the rest see 'conflict' and
 * simply keep their (already correct) snapshot. Best-effort by design.
 */
export async function commitAutoSpend(
  site: GodSite,
  now: Date = new Date(),
): Promise<GodSite> {
  const a = site.state.autoSpend
  if (!a?.enabled || a.dailyBudget <= 0) return site
  const today = autoDayKey(now, a.tzOffsetHours ?? 3)
  if (a.lastCommittedDay === today) return site

  const res = await mutateSite(site.id, null, (s) => {
    const cfg = s.autoSpend
    if (!cfg?.enabled || cfg.dailyBudget <= 0) return { invalid: 'auto off' }
    const t = autoDayKey(now, cfg.tzOffsetHours ?? 3)
    if (cfg.lastCommittedDay === t) return { invalid: 'already committed' }
    const days = cfg.lastCommittedDay
      ? Math.min(daysBetween(cfg.lastCommittedDay, t), 366)
      : 0 // first enable: start the clock, nothing to commit yet
    const spent = Math.min(days * cfg.dailyBudget, s.balance)
    return {
      ...s,
      balance: round2(s.balance - spent),
      autoSpend: {
        ...cfg,
        lastCommittedDay: t,
        // Anchor «Всё время»: the first commit after enabling stamps the
        // start day; existing sites adopt the earliest day we know about.
        startDay: cfg.startDay ?? cfg.lastCommittedDay ?? t,
      },
    }
  })
  return res.ok
    ? { ...site, state: res.state, revision: res.revision }
    : site // benign no-op or lost race — snapshot is still valid
}

/* --------------------------- Period projection -------------------------- */

/** The exact `State` payload page3.html consumes (contract §6). */
export interface PageStatePayload {
  login: string
  period: SitePeriod
  balance: number
  currency: string
  /** Organization card fields — omitted when blank (page falls back to «—»). */
  organization?: string
  phone?: string
  orgId?: string
  /**
   * Curated recommendations — omitted entirely when none are set, so the
   * page computes its own (contract: absent field = auto mode).
   */
  recommendations?: SiteRecommendation[]
  campaigns: SiteCampaign[]
}

/** How many calendar days each aggregate period spans (including today). */
function periodDayCount(
  period: SitePeriod,
  auto: AutoSpend,
  todayKey: string,
): number {
  if (period === 'week') return 7
  if (period === 'month') return 30
  // «Всё время»: anchored at the day auto-spend was enabled; capped so a
  // stale anchor can't turn one GET into thousands of day simulations.
  // Fallback (no anchor yet — first day of a fresh site): month-sized.
  const anchored = auto.startDay
    ? daysBetween(auto.startDay, todayKey) + 1
    : 30
  return Math.max(1, Math.min(anchored, 365))
}

/**
 * Sum the deterministic day simulations over an aggregate period: finished
 * days at fraction = 1 plus today's live partial. Each day is seeded by its
 * own date — the same seeds `yesterday` and `today` use — so the aggregate
 * is exactly the sum of what the vitrine showed (or will show) day by day:
 * week/month/all стало правдоподобным без ручных оверрайдов. Deterministic
 * within a day and only ever grows (today's partial is the only moving part).
 */
function aggregateAutoPeriod(
  state: SiteState,
  period: SitePeriod,
  now: Date,
): SiteCampaign[] {
  const auto = state.autoSpend as AutoSpend
  const tz = auto.tzOffsetHours ?? 3
  const todayKey = autoDayKey(now, tz)
  const days = periodDayCount(period, auto, todayKey)

  // Running totals per campaign id; bounce averaged with spend weights.
  const totals = new Map<
    string,
    { cost: number; shows: number; clicks: number; goals: number; revenue: number; bounceWeighted: number }
  >()
  const add = (c: SiteCampaign) => {
    const t = totals.get(c.id) ?? {
      cost: 0,
      shows: 0,
      clicks: 0,
      goals: 0,
      revenue: 0,
      bounceWeighted: 0,
    }
    t.cost += c.cost
    t.shows += c.shows
    t.clicks += c.clicks
    t.goals += c.goals
    t.revenue += c.revenue
    t.bounceWeighted += c.bounce * c.cost
    totals.set(c.id, t)
  }

  for (let i = days - 1; i >= 1; i--) {
    const dayKey = autoDayKey(new Date(now.getTime() - i * 86_400_000), tz)
    const sim = simulateAutoDay(state, dayKey, 1, auto.dailyBudget)
    for (const c of sim.campaigns) if (c.status === 'running') add(c)
  }
  // Today's live partial — same numbers the `today` period shows right now.
  const todaySim = simulateAutoDay(
    state,
    todayKey,
    autoDayFraction(now, tz),
    state.balance,
  )
  for (const c of todaySim.campaigns) if (c.status === 'running') add(c)

  return state.campaigns.map((c) => {
    const t = totals.get(c.id)
    if (!t) return c // stopped campaigns keep their hand-edited numbers
    return {
      ...c,
      cost: round2(t.cost),
      shows: Math.round(t.shows),
      clicks: Math.round(t.clicks),
      goals: Math.round(t.goals),
      revenue: round2(t.revenue),
      bounce: round2(t.cost > 0 ? Math.min(100, t.bounceWeighted / t.cost) : c.bounce),
    }
  })
}

/**
 * Project the canonical state onto a period (contract §3): base campaign
 * fields + per-period metric overlays when the god panel curated them, plus
 * the auto-spend simulation when enabled — `today` live (grows with the
 * clock), `yesterday` as a finished day (fraction = 1), and week/month/all
 * as SUMS of the per-day simulations (finished days + today's partial), so
 * aggregate periods look plausible instead of echoing today's numbers.
 * Hand-curated overrides always win over the simulation (applied on top,
 * per campaign per field). periodOverrides and autoSpend themselves are NOT
 * exposed — the page is a dumb витрина and the payload carries nothing
 * beyond the contract's `State`.
 */
export function stateForPeriod(
  state: SiteState,
  period: SitePeriod,
  now: Date = new Date(),
): PageStatePayload {
  const overrides = state.periodOverrides?.[period]
  let campaigns = state.campaigns
  let balance = state.balance

  const auto = state.autoSpend
  if (auto?.enabled && auto.dailyBudget > 0) {
    const tz = auto.tzOffsetHours ?? 3
    if (period === 'today') {
      const sim = simulateAutoDay(
        state,
        autoDayKey(now, tz),
        autoDayFraction(now, tz),
        state.balance,
      )
      campaigns = sim.campaigns
      balance = round2(Math.max(0, state.balance - sim.totalSpent))
    } else if (period === 'yesterday') {
      // Finished day: full curve, seeded with yesterday's date. Balance is
      // already committed for that day — show the live one untouched.
      const y = autoDayKey(new Date(now.getTime() - 86_400_000), tz)
      campaigns = simulateAutoDay(state, y, 1, auto.dailyBudget).campaigns
    } else {
      // week / month / all: sum of per-day simulations.
      campaigns = aggregateAutoPeriod(state, period, now)
    }
  }

  // Hand-curated overrides win over simulation and base, field by field.
  if (overrides && period !== 'today') {
    campaigns = campaigns.map((c) =>
      overrides[c.id] ? { ...c, ...overrides[c.id] } : c,
    )
  }

  return {
    login: state.login,
    period,
    balance,
    currency: state.currency,
    // Blank organization fields are omitted (page shows its «—» default);
    // recommendations are omitted when none curated → page auto-computes.
    ...(state.organization ? { organization: state.organization } : {}),
    ...(state.phone ? { phone: state.phone } : {}),
    ...(state.orgId ? { orgId: state.orgId } : {}),
    ...(state.recommendations && state.recommendations.length > 0
      ? { recommendations: state.recommendations }
      : {}),
    campaigns,
  }
}

/* ------------------------- Revision-safe mutation ----------------------- */

/**
 * Apply a state transformation under optimistic locking. `expected` is the
 * revision the caller believes is current (from If-Match / body); pass null
 * to skip the check (contract §5 allows clients that don't track revisions).
 * The WHERE-guarded UPDATE makes the check-and-set atomic.
 */
async function mutateSite(
  siteId: string,
  expected: number | null,
  transform: (state: SiteState) => SiteState | { invalid: string },
): Promise<MutationResult> {
  const rows = await query<SiteRow>(`SELECT * FROM god_sites WHERE id = $1`, [
    siteId,
  ])
  if (!rows[0]) return { ok: false, error: 'not_found' }
  const current = toSite(rows[0])

  if (expected !== null && expected !== 0 && expected !== current.revision) {
    return { ok: false, error: 'conflict', revision: current.revision }
  }

  const next = transform(current.state)
  if ('invalid' in next) {
    return { ok: false, error: 'invalid', message: next.invalid }
  }

  const updated = await query<SiteRow>(
    `UPDATE god_sites
        SET state = $2::jsonb, revision = revision + 1, updated_at = now()
      WHERE id = $1 AND revision = $3
      RETURNING *`,
    [siteId, JSON.stringify(next), current.revision],
  )
  // Row vanished or revision moved between our read and write — a concurrent
  // writer won; report a conflict with the freshest revision we can get.
  if (!updated[0]) {
    const fresh = await query<SiteRow>(
      `SELECT revision FROM god_sites WHERE id = $1`,
      [siteId],
    )
    if (!fresh[0]) return { ok: false, error: 'not_found' }
    return { ok: false, error: 'conflict', revision: Number(fresh[0].revision) }
  }
  const site = toSite(updated[0])
  return { ok: true, revision: site.revision, state: site.state }
}

/* --------------------------- God-panel actions -------------------------- */

/*
 * NOTE: there are deliberately NO page-facing mutations. The contract is
 * read-only — page3.html never sends writes; every change flows through the
 * god-panel editor (saveSiteState below).
 */

export async function listSites(): Promise<GodSite[]> {
  const rows = await query<SiteRow>(
    `SELECT * FROM god_sites ORDER BY created_at DESC`,
  )
  return rows.map(toSite)
}

export async function getSiteById(id: string): Promise<GodSite | null> {
  const rows = await query<SiteRow>(`SELECT * FROM god_sites WHERE id = $1`, [
    id,
  ])
  return rows[0] ? toSite(rows[0]) : null
}

/** Create a site; the returned apiKey is shown ONCE and never recoverable. */
export async function createSite(
  slug: string,
  title: string,
  initialState?: unknown,
): Promise<{ site: GodSite; apiKey: string }> {
  const apiKey = generateApiKey()
  const state = sanitizeState(initialState)
  const rows = await query<SiteRow>(
    `INSERT INTO god_sites (slug, title, api_key_hash, state)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [slug, title, hashApiKey(apiKey), JSON.stringify(state)],
  )
  return { site: toSite(rows[0]), apiKey }
}

/** Rotate the API key — the old key stops working immediately. */
export async function rotateSiteKey(
  id: string,
): Promise<{ apiKey: string } | null> {
  const apiKey = generateApiKey()
  const rows = await query<{ id: string }>(
    `UPDATE god_sites SET api_key_hash = $2, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, hashApiKey(apiKey)],
  )
  return rows[0] ? { apiKey } : null
}

export async function deleteSite(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM god_sites WHERE id = $1 RETURNING id`,
    [id],
  )
  return Boolean(rows[0])
}

/**
 * God-panel full-state save (the "Сайты" tab editor). Same optimistic locking
 * as page mutations so a panel edit can't silently clobber a page edit.
 */
export async function saveSiteState(
  id: string,
  rawState: unknown,
  expected: number | null,
): Promise<MutationResult> {
  return mutateSite(id, expected, () => sanitizeState(rawState))
}

export async function renameSite(
  id: string,
  title: string,
): Promise<boolean> {
  const t = str(title).trim()
  if (!t) return false
  const rows = await query<{ id: string }>(
    `UPDATE god_sites SET title = $2, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, t],
  )
  return Boolean(rows[0])
}
