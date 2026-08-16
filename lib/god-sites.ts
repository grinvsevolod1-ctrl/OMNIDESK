import 'server-only'

import { createHash, randomBytes } from 'crypto'
import { query } from './db'
import {
  autoDayFraction,
  autoDayKey,
  DEFAULT_DAY_JITTER,
  DEFAULT_WEEKEND_DIP,
  dayCurveFraction,
  daysBetween,
  jitter,
  round2,
  SPEND_PROFILES,
  type SpendProfile,
  weekdayFactor,
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
   * Day (YYYY-MM-DD in panel TZ) auto-spend was enabled — the anchor for ALL
   * aggregate periods (week/month/all are clamped to it, so a site enabled
   * yesterday never shows «7 × дневной бюджет» for the week). Stamped by
   * saveSiteState on the off→on transition (re-enable = fresh start);
   * commitAutoSpend backfills it for legacy sites.
   */
  startDay?: string
  /**
   * Cumulative amount actually committed (deducted from the balance) since
   * startDay. Lets aggregates cap simulated history by the money that really
   * existed. Maintained by commitAutoSpend; absent on legacy sites (no cap).
   */
  spentToDate?: number
  /** Day boundary timezone, hours east of UTC. Default +3 (Moscow). */
  tzOffsetHours?: number
  /* ---- Curve settings (all optional; defaults = historical behaviour) ---- */
  /**
   * Day shape preset. Absent → the historical step curve via autoDayFraction
   * (bit-exact backwards compatibility for existing sites).
   */
  profile?: SpendProfile
  /** S-curve smoothing 0..1 (0 = stepped hourly rate, 1 = fully smooth). */
  smoothness?: number
  /** Weekend dip strength 0..0.5 (Sun −dip, Sat −dip·0.75, Fri −dip·0.25). */
  weekendDip?: number
  /** Deterministic day-to-day budget jitter amplitude 0..0.2. */
  dayJitter?: number
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
 * Share of the daily budget burnt by `now`, honouring the curve settings:
 * with a profile set — the smoothed S-curve; without — the historical step
 * curve (bit-exact backwards compatibility for pre-existing sites).
 */
function curveFraction(cfg: AutoSpend, now: Date, tz: number): number {
  return cfg.profile
    ? dayCurveFraction(now, tz, cfg.profile, cfg.smoothness ?? 0.6)
    : autoDayFraction(now, tz)
}

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

  // Effective budget follows a weekly rhythm (weekends dip) plus a small
  // per-date jitter, so aggregate curves look alive instead of identical
  // days. Deterministic from the date — every reader agrees. Dip and jitter
  // amplitudes come from the curve settings (defaults = historical values).
  const effectiveBudget =
    cfg.dailyBudget *
    weekdayFactor(dayKey, cfg.weekendDip ?? DEFAULT_WEEKEND_DIP) *
    jitter(`${dayKey}:day`, cfg.dayJitter ?? DEFAULT_DAY_JITTER)
  const totalSpent = round2(
    Math.min(effectiveBudget * fraction, Math.max(0, budgetCap)),
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
    // Sum the SAME per-day simulations the vitrine showed for each finished
    // day (weekday rhythm + jitter included) — the deduction always matches
    // what the page displayed, instead of a flat days × dailyBudget.
    let owed = 0
    if (days > 0 && cfg.lastCommittedDay) {
      const startMs = Date.parse(`${cfg.lastCommittedDay}T12:00:00Z`)
      for (let j = 0; j < days; j++) {
        const dayKey = new Date(startMs + j * 86_400_000)
          .toISOString()
          .slice(0, 10)
        owed += simulateAutoDay(s, dayKey, 1, Number.POSITIVE_INFINITY)
          .totalSpent
      }
    }
    const spent = round2(Math.min(owed, s.balance))
    return {
      ...s,
      balance: round2(s.balance - spent),
      autoSpend: {
        ...cfg,
        lastCommittedDay: t,
        // Anchor for aggregates: normally stamped by saveSiteState at enable;
        // legacy sites adopt the earliest day we know about.
        startDay: cfg.startDay ?? cfg.lastCommittedDay ?? t,
        spentToDate: round2((cfg.spentToDate ?? 0) + spent),
      },
    }
  })
  return res.ok
    ? { ...site, state: res.state, revision: res.revision }
    : site // benign no-op or lost race — snapshot is still valid
}

/**
 * Balance exactly as the vitrine shows it right now: stored balance minus
 * today's live partial spend. Reuses the same simulation stateForPeriod
 * ('today') runs, so the panel can never disagree with the page.
 */
export function liveBalance(state: SiteState, now: Date = new Date()): number {
  const a = state.autoSpend
  if (!a?.enabled || a.dailyBudget <= 0) return state.balance
  const tz = a.tzOffsetHours ?? 3
  const sim = simulateAutoDay(
    state,
    autoDayKey(now, tz),
    curveFraction(a, now, tz),
    state.balance,
  )
  return round2(Math.max(0, state.balance - sim.totalSpent))
}

/**
 * Atomic top-up: ADDS to the current stored balance server-side, so the
 * operator never has to read-modify-write the number by hand (a hand-set
 * value races against auto-spend commits; an increment cannot). No revision
 * check by design — "add N" is valid no matter who edited what meanwhile.
 */
export async function topUpBalance(
  id: string,
  amount: number,
): Promise<MutationResult> {
  const a = round2(amount)
  if (!Number.isFinite(a) || a <= 0 || a > MAX_NUM) {
    return { ok: false, error: 'invalid', message: 'Некорректная сумма' }
  }
  return mutateSite(id, null, (s) => ({
    ...s,
    balance: round2(Math.min(s.balance + a, MAX_NUM)),
  }))
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

/**
 * How many calendar days each aggregate period spans (including today).
 * EVERY period is clamped by the auto-spend start anchor: a site whose
 * auto-spend was enabled yesterday shows «Неделя» = yesterday + today's
 * partial (~1 × дневной бюджет + текущий частичный), NOT 7 × бюджет — the
 * simulation cannot have history older than the day it was switched on.
 * No anchor yet (legacy site before its first commit): today only — better
 * to under-report than to invent phantom history. The 365 cap keeps a stale
 * anchor from turning one GET into thousands of day simulations.
 */
function periodDayCount(
  period: SitePeriod,
  auto: AutoSpend,
  todayKey: string,
): number {
  const anchored = auto.startDay ? daysBetween(auto.startDay, todayKey) + 1 : 1
  const span = period === 'week' ? 7 : period === 'month' ? 30 : 365
  return Math.max(1, Math.min(span, anchored))
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

  let finishedCost = 0
  for (let i = days - 1; i >= 1; i--) {
    const dayKey = autoDayKey(new Date(now.getTime() - i * 86_400_000), tz)
    const sim = simulateAutoDay(state, dayKey, 1, Number.POSITIVE_INFINITY)
    finishedCost += sim.totalSpent
    for (const c of sim.campaigns) if (c.status === 'running') add(c)
  }
  // Cap finished-day history by the money that actually existed: spentToDate
  // is what commitAutoSpend really deducted (already balance-capped), so the
  // simulated history can never claim more spend than there was cash. When
  // the sim overshoots, all metrics scale down proportionally — ratios (CPC,
  // CR, ДРР) stay intact. Legacy sites without the counter keep the old
  // uncapped behaviour.
  if (typeof auto.spentToDate === 'number' && finishedCost > 0) {
    const factor = Math.min(1, auto.spentToDate / finishedCost)
    if (factor < 1) {
      for (const t of totals.values()) {
        t.cost *= factor
        t.shows *= factor
        t.clicks *= factor
        t.goals *= factor
        t.revenue *= factor
        t.bounceWeighted *= factor
      }
    }
  }
  // Today's live partial — same numbers the `today` period shows right now.
  const todaySim = simulateAutoDay(
    state,
    todayKey,
    curveFraction(auto, now, tz),
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
    // Balance is a single "money in the account right now" figure — a real
    // ad cabinet never changes it when you switch the stats period, only the
    // campaign statistics below change. So the balance is ALWAYS today's live
    // balance (stored minus today's partial burn), for every period. This is
    // what the `today` view always showed; previously yesterday/week/month/all
    // leaked the raw stored balance (no spend deducted), which looked like the
    // balance "jumped back up" when you filtered by yesterday.
    const todaySim = simulateAutoDay(
      state,
      autoDayKey(now, tz),
      curveFraction(auto, now, tz),
      state.balance,
    )
    balance = round2(Math.max(0, state.balance - todaySim.totalSpent))

    if (period === 'today') {
      campaigns = todaySim.campaigns
    } else if (period === 'yesterday') {
      // Finished day: full curve, seeded with yesterday's date. Uncapped —
      // the weekday rhythm/jitter may push the effective budget slightly
      // above the nominal dailyBudget, and that's the point.
      const y = autoDayKey(new Date(now.getTime() - 86_400_000), tz)
      campaigns = simulateAutoDay(state, y, 1, Number.POSITIVE_INFINITY)
        .campaigns
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

/**
 * Create a site. The key is PERMANENT (migration 137): plaintext is stored
 * alongside the hash by owner decision — this is a closed system and every
 * downloaded extension archive must keep working forever, which beats
 * hash-only storage here.
 */
export async function createSite(
  slug: string,
  title: string,
  initialState?: unknown,
): Promise<{ site: GodSite; apiKey: string }> {
  const apiKey = generateApiKey()
  // A brand-new site with auto-spend already on gets its anchor immediately
  // (prev = empty state → off→on transition).
  const state = stampAutoSpendStart(
    sanitizeState(initialState),
    sanitizeState(undefined),
    new Date(),
  )
  const rows = await query<SiteRow>(
    `INSERT INTO god_sites (slug, title, api_key_hash, api_key_plain, state)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [slug, title, hashApiKey(apiKey), apiKey, JSON.stringify(state)],
  )
  return { site: toSite(rows[0]), apiKey }
}

/**
 * The ONE permanent key for a site. Normal path: return the stored plaintext.
 * Legacy path (site created before migration 137 — plaintext is not
 * recoverable from the hash): mint a key ONCE, persist plaintext + hash
 * atomically-guarded (`api_key_plain IS NULL` in WHERE makes a concurrent
 * double-mint impossible — the loser re-reads the winner's key), and from
 * then on the key never changes. Old archives of a legacy site work until
 * this one final re-issue; after it, every archive is forever-valid.
 */
export async function getOrCreateSiteKey(id: string): Promise<string | null> {
  const existing = await query<{ api_key_plain: string | null }>(
    `SELECT api_key_plain FROM god_sites WHERE id = $1`,
    [id],
  )
  if (!existing[0]) return null
  if (existing[0].api_key_plain) return existing[0].api_key_plain

  const candidate = generateApiKey()
  const updated = await query<{ api_key_plain: string }>(
    `UPDATE god_sites
        SET api_key_plain = $2, api_key_hash = $3, updated_at = now()
      WHERE id = $1 AND api_key_plain IS NULL
      RETURNING api_key_plain`,
    [id, candidate, hashApiKey(candidate)],
  )
  if (updated[0]) return updated[0].api_key_plain
  // Lost the race — another request minted first; use theirs.
  const winner = await query<{ api_key_plain: string | null }>(
    `SELECT api_key_plain FROM god_sites WHERE id = $1`,
    [id],
  )
  return winner[0]?.api_key_plain ?? null
}

/**
 * Manual re-issue from the UI («Ротация» button) — the ONLY path that changes
 * the permanent key. All previously downloaded archives die at once; the
 * extension download flow deliberately does NOT call this anymore.
 */
export async function rotateSiteKey(
  id: string,
): Promise<{ apiKey: string } | null> {
  const apiKey = generateApiKey()
  const rows = await query<{ id: string }>(
    `UPDATE god_sites
        SET api_key_hash = $2, api_key_plain = $3, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, hashApiKey(apiKey), apiKey],
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
 * Stamp the auto-spend anchor on the off→on transition. Re-enabling is a
 * FRESH START by design: new startDay (= today), commit clock reset to today
 * (today's partial is live-projected, tomorrow's first read commits it) and
 * the spent counter zeroed — aggregates begin from the moment of the switch,
 * never from stale history of a previous run.
 */
function stampAutoSpendStart(
  next: SiteState,
  prev: SiteState,
  now: Date,
): SiteState {
  const a = next.autoSpend
  if (!a?.enabled || a.dailyBudget <= 0) return next
  const wasEnabled =
    prev.autoSpend?.enabled === true && (prev.autoSpend?.dailyBudget ?? 0) > 0
  if (wasEnabled) return next // already running — keep its anchor untouched
  const today = autoDayKey(now, a.tzOffsetHours ?? 3)
  return {
    ...next,
    autoSpend: {
      ...a,
      startDay: today,
      lastCommittedDay: today,
      spentToDate: 0,
    },
  }
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
  const now = new Date()
  return mutateSite(id, expected, (prev) =>
    stampAutoSpendStart(sanitizeState(rawState), prev, now),
  )
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

/* ----------------------- Extension generator (beta) --------------------- */

/** Where the "яндекс N" numbering starts (see migration 136). */
export const EXT_LABEL_SEQ_START = 11

/**
 * Assign this site its permanent "яндекс N" number on first download, as
 * MAX(ext_label_seq)+1 across all sites (floor EXT_LABEL_SEQ_START). Once set
 * it never changes — subsequent downloads reuse it (COALESCE on the current
 * row makes the common path idempotent). Two CONCURRENT first-downloads of
 * different sites can still compute the same MAX+1 — the unique partial index
 * rejects the loser, so we retry once with a recomputed MAX instead of
 * bubbling a raw constraint violation to the UI.
 */
export async function assignExtLabelSeq(id: string): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rows = await query<{ ext_label_seq: number }>(
        `UPDATE god_sites AS g
            SET ext_label_seq = COALESCE(
                  g.ext_label_seq,
                  GREATEST(
                    $2::int,
                    COALESCE((SELECT MAX(ext_label_seq) FROM god_sites), $2::int - 1) + 1
                  )
                ),
                updated_at = now()
          WHERE g.id = $1
          RETURNING ext_label_seq`,
        [id, EXT_LABEL_SEQ_START],
      )
      return rows[0] ? Number(rows[0].ext_label_seq) : null
    } catch (e) {
      // 23505 = unique_violation: a concurrent first-download won the number.
      const code = (e as { code?: string })?.code
      if (code !== '23505' || attempt === 1) throw e
    }
  }
  return null
}

/**
 * Bump and return the per-site download counter → manifest version "1.0.K".
 * Chrome refuses to reload an unpacked extension whose version didn't change,
 * so every download must produce a strictly greater K.
 */
export async function bumpExtVersion(id: string): Promise<number | null> {
  const rows = await query<{ ext_version: number }>(
    `UPDATE god_sites SET ext_version = ext_version + 1, updated_at = now()
      WHERE id = $1 RETURNING ext_version`,
    [id],
  )
  return rows[0] ? Number(rows[0].ext_version) : null
}
