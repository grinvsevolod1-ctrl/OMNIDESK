import type { SpendProfile } from './god-sites-sim'

/**
 * Shared types + period constants for god-panel managed sites.
 *
 * Extracted verbatim from god-sites.ts so the pure type/constant surface lives
 * apart from the DB layer. god-sites.ts re-exports everything here, so every
 * existing `@/lib/god-sites` import keeps working unchanged.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only — same as god-sites.ts.
 */

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
  /* ---- Frozen ledger (server-owned, never taken from the editor) ---- */
  /**
   * Day (panel TZ) the frozen ledger started. Present = "ledger mode": past
   * days come from `days`/`archive` (never re-simulated with new settings),
   * today = `bank` + live delta, and a stopped campaign's budget share is
   * NOT redistributed to the others. Absent = legacy projection (bit-exact
   * with the numbers the vitrine showed before the ledger existed).
   */
  historyFrom?: string
  /** Finished days (last LEDGER_DAYS) — exactly what the vitrine showed. */
  days?: Record<string, AutoDayRecord>
  /** Per-campaign totals of finished days older than the `days` window. */
  archive?: Record<string, DayMetrics>
  /**
   * Today's already-fixed part (deducted from `balance` at bank time):
   * spend up to `fraction` of the day under the settings in force until the
   * last change. Live today = bank + delta(fraction → now) under current
   * settings — so a settings change / disable never rewrites what's shown.
   */
  bank?: AutoDayBank
  /**
   * «Всё время» baseline set by hand: per campaign, `base` is the operator's
   * authoritative all-time figure at `setAt`, `minus` is what the ledger's
   * all-time sum was at that moment. Shown = base + (ledger now − minus), so
   * only spend AFTER the baseline accrues on top of it.
   */
  allTime?: AllTimeBaseline
  /**
   * Per-site seed salt (= site id, stamped by the DB layer). Days on/after
   * `seedFrom` are simulated with it — own daily rhythm per site, fractional
   * counts, livelier ratios. Earlier days keep the historical seeds.
   */
  seedSalt?: string
  seedFrom?: string
}

export interface AllTimeBaseline {
  setAt: string
  base: Record<string, DayMetrics>
  minus: Record<string, DayMetrics>
}

/** Per-campaign metrics of one day (or a sum of days). */
export interface DayMetrics {
  cost: number
  shows: number
  clicks: number
  goals: number
  revenue: number
  /** Spend-weighted average. */
  bounce: number
}

export interface AutoDayRecord {
  spent: number
  campaigns: Record<string, DayMetrics>
}

export interface AutoDayBank extends AutoDayRecord {
  day: string
  fraction: number
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
  /**
   * «Аккаунт заблокирован»: the vitrine replaces ALL content with a plain
   * white page («Аккаунт заблокирован» top-center) and swaps the tab title.
   * Stored ONLY as literal `true` (absent = normal), so legacy states stay
   * byte-identical after a sanitize round-trip.
   */
  blocked?: true
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
  /**
   * Permanent «яндекс N» extension label (migration 136) — null until the
   * first download assigns it. Surfaced so the list can identify which
   * archive belongs to which site without re-downloading.
   */
  extLabelSeq: number | null
  /** Per-site download counter → manifest version «1.0.K». 0 = never built. */
  extVersion: number
}

export type MutationResult =
  | { ok: true; revision: number; state: SiteState }
  | { ok: false; error: 'conflict'; revision: number }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'invalid'; message: string }

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
  /**
   * Account-blocked flag — present (literal `true`) only when the god panel
   * blocked the account; the page then wipes itself to the white
   * «Аккаунт заблокирован» screen. Absent = normal render.
   */
  blocked?: true
}

export function normalizePeriod(v: unknown): SitePeriod {
  return SITE_PERIODS.includes(v as SitePeriod) ? (v as SitePeriod) : 'today'
}
