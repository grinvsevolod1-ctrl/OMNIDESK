import {
  autoDayFraction,
  autoDayKey,
  DEFAULT_DAY_JITTER,
  DEFAULT_WEEKEND_DIP,
  dayCurveFraction,
  daysBetween,
  jitter,
  round2,
  weekdayFactor,
} from './god-sites-sim'
import type {
  AutoDayRecord,
  AutoSpend,
  DayMetrics,
  PageStatePayload,
  SiteCampaign,
  SitePeriod,
  SiteState,
} from './god-sites-types'

/**
 * Pure auto-spend simulation and period projection for god-panel sites.
 *
 * Everything here is a PURE function of (state, wall-clock time) — no DB, no
 * side effects, deterministic and safe to call from both the panel and the
 * page endpoints. Extracted from god-sites.ts along the natural seam between
 * "compute what the vitrine shows" (here) and "read/write the DB"
 * (god-sites.ts). god-sites.ts re-exports the public members, so existing
 * `@/lib/god-sites` imports are unaffected, and it imports `simulateAutoDay`
 * back for commitAutoSpend's day-rollover math.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only — same as god-sites.ts.
 */

/*
 * Deterministic intraday burner. The projection is a PURE function of
 * (state, wall-clock time): every GET recomputes "how much has been spent by
 * now" from the daily budget and a natural traffic curve — no cron, no
 * background writers, and concurrent readers always agree. Numbers only ever
 * grow within a day (the curve is cumulative and per-day jitter is fixed), so
 * the vitrine sees a live cabinet that spends by itself. At day rollover the
 * finished day's budget is committed to the stored balance lazily, on the
 * first read of the new day (commitAutoSpend in god-sites.ts).
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
export function simulateAutoDay(
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
  // Budget shares: base cost → weekly budget → equal, jittered ±8% per day.
  const weightOf = (c: SiteCampaign) =>
    (c.cost > 0 ? c.cost : c.weeklyBudget > 0 ? c.weeklyBudget / 7 : 1) *
    jitter(`${dayKey}:${c.id}:w`, 0.08)
  const weights = running.map(weightOf)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  // Ledger mode: a stopped campaign keeps its share of the daily budget
  // (the share simply stops burning) instead of being redistributed onto the
  // running ones — «Остановить» really stops that spend. Legacy mode keeps
  // the historical running-only split (share = 1) bit-for-bit.
  let share = 1
  if (cfg.historyFrom && running.length < state.campaigns.length) {
    const all = state.campaigns.reduce((sum, c) => sum + weightOf(c), 0)
    share = all > 0 ? weightSum / all : 1
  }

  const effectiveBudget =
    cfg.dailyBudget *
    share *
    weekdayFactor(dayKey, cfg.weekendDip ?? DEFAULT_WEEKEND_DIP) *
    jitter(`${dayKey}:day`, cfg.dayJitter ?? DEFAULT_DAY_JITTER)
  const totalSpent = round2(
    Math.min(effectiveBudget * fraction, Math.max(0, budgetCap)),
  )

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

/* =========================================================================
 * Frozen ledger
 *
 * Legacy mode re-simulated EVERY past day with the CURRENT settings, so any
 * edit (budget, profile, TZ, campaign stop, disable) silently rewrote
 * «Вчера / Неделя / Месяц / Всё время» and today's already-burnt spend. The
 * ledger freezes what the vitrine showed at the moment it becomes history:
 *   - finished days → `days` (last LEDGER_KEEP_DAYS) + `archive` (older);
 *   - today's burnt part on any relevant change → `bank` (and deducted from
 *     the stored balance right away, so disabling never "returns" money).
 * A legacy site switches to the ledger LAZILY — on its first rollover or
 * first relevant save — by materializing exactly the numbers the legacy
 * projection was showing at that moment, so nothing on the vitrine shifts.
 * ======================================================================= */

/** Finished days kept per-day (month view needs 29 + today). */
export const LEDGER_KEEP_DAYS = 29
const MAX_ROLLOVER_DAYS = 366

function isOn(a: AutoSpend | undefined): boolean {
  return Boolean(a?.enabled) && (a?.dailyBudget ?? 0) > 0
}

function tzOf(a: AutoSpend): number {
  return a.tzOffsetHours ?? 3
}

/** YYYY-MM-DD ± n calendar days. */
export function shiftDay(key: string, delta: number): string {
  return new Date(Date.parse(`${key}T12:00:00Z`) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

/**
 * Ledger "today": never earlier than lastCommittedDay. Moving the TZ back
 * across midnight must not re-open an already committed day (it would be
 * charged twice) — the calendar only moves forward.
 */
function ledgerTodayKey(a: AutoSpend, now: Date): string {
  const k = autoDayKey(now, tzOf(a))
  return a.lastCommittedDay && a.lastCommittedDay > k ? a.lastCommittedDay : k
}

const ZERO_METRICS: DayMetrics = {
  cost: 0,
  shows: 0,
  clicks: 0,
  goals: 0,
  revenue: 0,
  bounce: 0,
}

function metricsOf(c: SiteCampaign): DayMetrics {
  return {
    cost: c.cost,
    shows: c.shows,
    clicks: c.clicks,
    goals: c.goals,
    revenue: c.revenue,
    bounce: c.bounce,
  }
}

function addMetrics(a: DayMetrics, b: DayMetrics): DayMetrics {
  const cost = a.cost + b.cost
  return {
    cost: round2(cost),
    shows: a.shows + b.shows,
    clicks: a.clicks + b.clicks,
    goals: a.goals + b.goals,
    revenue: round2(a.revenue + b.revenue),
    bounce:
      cost > 0
        ? round2(Math.min(100, (a.bounce * a.cost + b.bounce * b.cost) / cost))
        : b.bounce || a.bounce,
  }
}

function subMetrics(hi: DayMetrics, lo: DayMetrics): DayMetrics {
  return {
    cost: Math.max(0, round2(hi.cost - lo.cost)),
    shows: Math.max(0, hi.shows - lo.shows),
    clicks: Math.max(0, hi.clicks - lo.clicks),
    goals: Math.max(0, hi.goals - lo.goals),
    revenue: Math.max(0, round2(hi.revenue - lo.revenue)),
    bounce: hi.bounce,
  }
}

function scaleMetrics(m: DayMetrics, k: number): DayMetrics {
  return {
    cost: round2(m.cost * k),
    shows: Math.round(m.shows * k),
    clicks: Math.round(m.clicks * k),
    goals: Math.round(m.goals * k),
    revenue: round2(m.revenue * k),
    bounce: m.bounce,
  }
}

function mergeMetricMaps(
  a: Record<string, DayMetrics>,
  b: Record<string, DayMetrics>,
): Record<string, DayMetrics> {
  const out = { ...a }
  for (const [id, m] of Object.entries(b)) {
    out[id] = out[id] ? addMetrics(out[id], m) : m
  }
  return out
}

/** Metrics of the campaigns a simulation actually spent on (running only). */
function spentMetrics(campaigns: SiteCampaign[]): Record<string, DayMetrics> {
  const out: Record<string, DayMetrics> = {}
  for (const c of campaigns) if (c.status === 'running') out[c.id] = metricsOf(c)
  return out
}

/**
 * Spend of `dayKey` between curve fractions f0 → f under the CURRENT
 * settings, capped by `cap` money. With f0 = 0 this is exactly the legacy
 * `simulateAutoDay(state, day, f, cap)` — the bit-exact path for every day
 * that has no bank.
 */
function dayDelta(
  state: SiteState,
  dayKey: string,
  f0: number,
  f: number,
  cap: number,
): { campaigns: Record<string, DayMetrics>; spent: number } {
  if (f <= f0) return { campaigns: {}, spent: 0 }
  if (f0 <= 0) {
    const sim = simulateAutoDay(state, dayKey, f, cap)
    return { campaigns: spentMetrics(sim.campaigns), spent: sim.totalSpent }
  }
  const lo = simulateAutoDay(state, dayKey, f0, Number.POSITIVE_INFINITY)
  const hi = simulateAutoDay(state, dayKey, f, Math.max(0, cap) + lo.totalSpent)
  const loById = spentMetrics(lo.campaigns)
  const campaigns: Record<string, DayMetrics> = {}
  for (const [id, m] of Object.entries(spentMetrics(hi.campaigns))) {
    campaigns[id] = subMetrics(m, loById[id] ?? ZERO_METRICS)
  }
  return { campaigns, spent: Math.max(0, round2(hi.totalSpent - lo.totalSpent)) }
}

/**
 * Today as the vitrine shows it: frozen bank + live delta since the bank
 * under the current settings. `delta` is the part NOT yet deducted from the
 * stored balance (the bank already is).
 */
export function liveToday(
  state: SiteState,
  now: Date,
): { key: string; campaigns: Record<string, DayMetrics>; delta: number } {
  const a = state.autoSpend as AutoSpend
  const key = ledgerTodayKey(a, now)
  const bank = a.bank?.day === key ? a.bank : undefined
  const base = bank?.campaigns ?? {}
  if (!isOn(a)) return { key, campaigns: base, delta: 0 }
  const d = dayDelta(
    state,
    key,
    bank?.fraction ?? 0,
    curveFraction(a, now, tzOf(a)),
    state.balance,
  )
  return { key, campaigns: mergeMetricMaps(base, d.campaigns), delta: d.spent }
}

/** Close a whole day: bank (if any) + the rest of the curve up to 1. */
function closeDay(
  state: SiteState,
  dayKey: string,
  cap: number,
): { record: AutoDayRecord; spent: number } {
  const a = state.autoSpend as AutoSpend
  const bank = a.bank?.day === dayKey ? a.bank : undefined
  const d = isOn(a)
    ? dayDelta(state, dayKey, bank?.fraction ?? 0, 1, cap)
    : { campaigns: {}, spent: 0 }
  return {
    record: {
      spent: round2((bank?.spent ?? 0) + d.spent),
      campaigns: mergeMetricMaps(bank?.campaigns ?? {}, d.campaigns),
    },
    spent: d.spent,
  }
}

/** A finished day's record — frozen if committed, else what commit will write. */
function ledgerDay(
  state: SiteState,
  dayKey: string,
  todayKey: string,
): AutoDayRecord | undefined {
  const a = state.autoSpend as AutoSpend
  const frozen = a.days?.[dayKey]
  if (frozen) return frozen
  if (dayKey >= todayKey) return undefined
  const pending = a.lastCommittedDay != null && dayKey >= a.lastCommittedDay
  if (!pending) return undefined
  if (isOn(a)) return closeDay(state, dayKey, state.balance).record
  return a.bank?.day === dayKey ? a.bank : undefined
}

/** Move per-day records older than the window into the per-campaign archive. */
function pruneLedger(a: AutoSpend, todayKey: string): AutoSpend {
  if (!a.days) return a
  const days: Record<string, AutoDayRecord> = {}
  let archive = a.archive
  for (const [k, rec] of Object.entries(a.days)) {
    if (k < todayKey && daysBetween(k, todayKey) > LEDGER_KEEP_DAYS) {
      archive = mergeMetricMaps(archive ?? {}, rec.campaigns)
    } else {
      days[k] = rec
    }
  }
  return { ...a, days, ...(archive ? { archive } : {}) }
}

/**
 * Freeze the legacy projection into a ledger: finished days exactly as the
 * legacy week/month/all showed them (same seeds, same startDay clamp, same
 * spentToDate cap), so the switch is invisible on the vitrine.
 */
function materializeLegacy(
  state: SiteState,
  now: Date,
): { days: Record<string, AutoDayRecord>; archive?: Record<string, DayMetrics> } {
  const a = state.autoSpend as AutoSpend
  const tz = tzOf(a)
  const todayKey = autoDayKey(now, tz)
  const anchored = a.startDay ? daysBetween(a.startDay, todayKey) + 1 : 1
  const total = Math.max(1, Math.min(365, anchored))
  const sims: { key: string; rec: AutoDayRecord }[] = []
  for (let i = 1; i < total; i++) {
    const key = autoDayKey(new Date(now.getTime() - i * 86_400_000), tz)
    const sim = simulateAutoDay(state, key, 1, Number.POSITIVE_INFINITY)
    sims.push({
      key,
      rec: { spent: sim.totalSpent, campaigns: spentMetrics(sim.campaigns) },
    })
  }
  const capFactor = (n: number) => {
    if (typeof a.spentToDate !== 'number') return 1
    let cost = 0
    for (let i = 0; i < n; i++) cost += sims[i].rec.spent
    return cost > 0 ? Math.min(1, a.spentToDate / cost) : 1
  }
  const scaled = (rec: AutoDayRecord, k: number): AutoDayRecord =>
    k >= 1
      ? rec
      : {
          spent: round2(rec.spent * k),
          campaigns: Object.fromEntries(
            Object.entries(rec.campaigns).map(([id, m]) => [id, scaleMetrics(m, k)]),
          ),
        }
  const monthN = Math.min(LEDGER_KEEP_DAYS, sims.length)
  const fMonth = capFactor(monthN)
  const fAll = capFactor(sims.length)
  const days: Record<string, AutoDayRecord> = {}
  for (let i = 0; i < monthN; i++) days[sims[i].key] = scaled(sims[i].rec, fMonth)
  if (sims.length <= monthN) return { days }
  // Legacy «Всё время» capped the WHOLE sum with its own factor (≠ month's),
  // so archive = legacy all-time total − the month part stored per day.
  const sumOf = (from: number, to: number) => {
    let m: Record<string, DayMetrics> = {}
    for (let i = from; i < to; i++) m = mergeMetricMaps(m, sims[i].rec.campaigns)
    return m
  }
  const scaleMap = (m: Record<string, DayMetrics>, k: number) =>
    k >= 1
      ? m
      : Object.fromEntries(Object.entries(m).map(([id, v]) => [id, scaleMetrics(v, k)]))
  const allPart = scaleMap(sumOf(0, sims.length), fAll)
  const monthPart = scaleMap(sumOf(0, monthN), fMonth)
  const archive: Record<string, DayMetrics> = {}
  for (const [id, m] of Object.entries(allPart)) {
    archive[id] = subMetrics(m, monthPart[id] ?? ZERO_METRICS)
  }
  return { days, archive }
}

/** Cheap check: does this state have a day rollover pending right now? */
export function rolloverDue(state: SiteState, now: Date): boolean {
  const a = state.autoSpend
  if (!a) return false
  const t = autoDayKey(now, tzOf(a))
  if (!isOn(a)) return a.bank != null && a.bank.day < t
  return !a.lastCommittedDay || t > a.lastCommittedDay
}

/**
 * Pure day rollover: commit finished days to the balance and freeze them
 * into the ledger. Returns null when there's nothing to do. Legacy states
 * are committed with the historical math (identical deduction) and then
 * materialized into the ledger.
 */
export function rolloverAutoSpend(
  state: SiteState,
  now: Date,
): SiteState | null {
  const a = state.autoSpend
  if (!a) return null
  const t = autoDayKey(now, tzOf(a))

  if (!isOn(a)) {
    // Disabled mid-day: the banked partial becomes a finished day (it was
    // already deducted at disable time — nothing to charge).
    if (!a.bank || a.bank.day >= t) return null
    const { bank, ...rest } = a
    const days = { ...(rest.days ?? {}) }
    const prev = days[bank.day]
    days[bank.day] = prev
      ? {
          spent: round2(prev.spent + bank.spent),
          campaigns: mergeMetricMaps(prev.campaigns, bank.campaigns),
        }
      : { spent: bank.spent, campaigns: bank.campaigns }
    return { ...state, autoSpend: pruneLedger({ ...rest, days }, t) }
  }

  const L = a.lastCommittedDay
  if (L && t <= L) return null // never re-open (or re-charge) a committed day

  if (!a.historyFrom) {
    // Legacy commit — the exact historical deduction…
    const n = L ? Math.min(daysBetween(L, t), MAX_ROLLOVER_DAYS) : 0
    let owed = 0
    for (let j = 0; j < n && L; j++) {
      owed += simulateAutoDay(state, shiftDay(L, j), 1, Number.POSITIVE_INFINITY)
        .totalSpent
    }
    const spent = round2(Math.min(owed, state.balance))
    const committed: SiteState = {
      ...state,
      balance: round2(state.balance - spent),
      autoSpend: {
        ...a,
        lastCommittedDay: t,
        startDay: a.startDay ?? L ?? t,
        spentToDate: round2((a.spentToDate ?? 0) + spent),
      },
    }
    // …then freeze what the legacy projection shows from now on.
    const m = materializeLegacy(committed, now)
    return {
      ...committed,
      autoSpend: {
        ...(committed.autoSpend as AutoSpend),
        historyFrom: t,
        days: m.days,
        ...(m.archive ? { archive: m.archive } : {}),
      },
    }
  }

  // Ledger commit: close every finished day with its bank, sequentially
  // capped by the money left.
  const start = L ?? t
  const n = Math.min(daysBetween(start, t), MAX_ROLLOVER_DAYS)
  let remaining = state.balance
  let spentTotal = 0
  const days = { ...(a.days ?? {}) }
  for (let j = 0; j < n; j++) {
    const d = shiftDay(start, j)
    const { record, spent } = closeDay({ ...state, balance: remaining }, d, remaining)
    remaining = round2(Math.max(0, remaining - spent))
    spentTotal += spent
    if (record.spent > 0 || Object.keys(record.campaigns).length > 0) {
      const prev = days[d]
      days[d] = prev
        ? {
            spent: round2(prev.spent + record.spent),
            campaigns: mergeMetricMaps(prev.campaigns, record.campaigns),
          }
        : record
    }
  }
  const { bank: _bank, ...rest } = a
  return {
    ...state,
    balance: remaining,
    autoSpend: pruneLedger(
      {
        ...rest,
        lastCommittedDay: t,
        startDay: a.startDay ?? start,
        spentToDate: round2((a.spentToDate ?? 0) + spentTotal),
        days,
      },
      t,
    ),
  }
}

/**
 * Bank today's burnt part: freeze it (per campaign) and deduct it from the
 * stored balance. Legacy states are materialized first. The new bank's
 * fraction is measured under `measure` (the settings that will apply from
 * now on) when they address the same day, so the continuation neither
 * re-burns nor skips anything. No-op when auto-spend is off.
 */
export function freezeToday(
  state: SiteState,
  now: Date,
  measure: AutoSpend | undefined = state.autoSpend,
): SiteState {
  if (!isOn(state.autoSpend)) return state
  const a = state.autoSpend as AutoSpend
  const today = liveToday(state, now)
  const prevBank = a.bank?.day === today.key ? a.bank : undefined
  const ledger: Partial<AutoSpend> = a.historyFrom
    ? {}
    : (() => {
        const m = materializeLegacy(state, now)
        return {
          historyFrom: autoDayKey(now, tzOf(a)),
          days: m.days,
          ...(m.archive ? { archive: m.archive } : {}),
        }
      })()
  const sameDay =
    isOn(measure) &&
    ledgerTodayKey(
      { ...(measure as AutoSpend), lastCommittedDay: a.lastCommittedDay },
      now,
    ) ===
      today.key
  const fraction = sameDay
    ? curveFraction(measure as AutoSpend, now, tzOf(measure as AutoSpend))
    : curveFraction(a, now, tzOf(a))
  return {
    ...state,
    balance: round2(Math.max(0, state.balance - today.delta)),
    autoSpend: {
      ...a,
      ...ledger,
      bank: {
        day: today.key,
        fraction,
        spent: round2((prevBank?.spent ?? 0) + today.delta),
        campaigns: today.campaigns,
      },
    },
  }
}

const LEDGER_KEYS = [
  'lastCommittedDay',
  'startDay',
  'spentToDate',
  'historyFrom',
  'days',
  'archive',
  'bank',
] as const

function pickLedger(a: AutoSpend | undefined): Partial<AutoSpend> {
  const out: Record<string, unknown> = {}
  if (!a) return out
  for (const k of LEDGER_KEYS) if (a[k] !== undefined) out[k] = a[k]
  return out as Partial<AutoSpend>
}

function stripLedger(a: AutoSpend): AutoSpend {
  const out: Record<string, unknown> = { ...a }
  for (const k of LEDGER_KEYS) delete out[k]
  return out as unknown as AutoSpend
}

/** Everything the simulation depends on — a change here must freeze first. */
function autoFingerprint(s: SiteState): string {
  const a = s.autoSpend
  return JSON.stringify([
    isOn(a),
    a?.dailyBudget ?? 0,
    a?.tzOffsetHours ?? 3,
    a?.profile ?? null,
    a?.smoothness ?? null,
    a?.weekendDip ?? null,
    a?.dayJitter ?? null,
    s.campaigns
      .map((c) =>
        JSON.stringify([
          c.id,
          c.status,
          c.cost,
          c.shows,
          c.clicks,
          c.goals,
          c.revenue,
          c.bounce,
          c.weeklyBudget,
        ]),
      )
      .sort(),
  ])
}

/**
 * Enable transition. With a ledger: RESUME — history, startDay and the
 * spent counter survive; today's clock restarts from the current moment
 * (no instant «95% of the day» burn). Without: a fresh ledger from now.
 */
function resumeAutoSpend(a: AutoSpend, now: Date): AutoSpend {
  const tz = tzOf(a)
  const key = autoDayKey(now, tz)
  const fraction = curveFraction(a, now, tz)
  if (a.historyFrom) {
    const day = a.lastCommittedDay && a.lastCommittedDay > key ? a.lastCommittedDay : key
    const keep = a.bank?.day === day ? a.bank : undefined
    return {
      ...a,
      startDay: a.startDay ?? day,
      lastCommittedDay: day,
      spentToDate: a.spentToDate ?? 0,
      bank: {
        day,
        fraction,
        spent: keep?.spent ?? 0,
        campaigns: keep?.campaigns ?? {},
      },
    }
  }
  const { archive: _archive, ...rest } = a
  return {
    ...rest,
    startDay: key,
    lastCommittedDay: key,
    spentToDate: 0,
    historyFrom: key,
    days: {},
    bank: { day: key, fraction, spent: 0, campaigns: {} },
  }
}

/**
 * Merge an editor save into the stored state. The editor owns the config
 * and campaigns; the server owns the ledger (never taken from the client,
 * which may hold a stale copy). Any change that affects the simulation
 * first freezes today's burnt part under the OLD settings, so already shown
 * numbers — today, yesterday, week, month, all — never move. The balance
 * field is applied as the operator's delta over the snapshot they loaded.
 */
export function applyAutoSpendSave(
  next: SiteState,
  prevRaw: SiteState,
  now: Date,
): SiteState {
  const prev = rolloverAutoSpend(prevRaw, now) ?? prevRaw
  const balanceDelta = next.balance - prevRaw.balance
  const clampBalance = (b: number) => round2(Math.max(0, Math.min(b, 1_000_000_000)))
  const pa = prev.autoSpend
  const clientCfg = next.autoSpend
    ? stripLedger(next.autoSpend)
    : pa
      ? { ...stripLedger(pa), enabled: false }
      : undefined
  if (!clientCfg) {
    return { ...next, balance: clampBalance(prev.balance + balanceDelta) }
  }
  const candidate: SiteState = {
    ...next,
    autoSpend: { ...clientCfg, ...pickLedger(pa) },
  }
  if (autoFingerprint(prev) === autoFingerprint(candidate)) {
    return { ...candidate, balance: clampBalance(prev.balance + balanceDelta) }
  }
  const base = isOn(pa) ? freezeToday(prev, now, clientCfg) : prev
  let cfg: AutoSpend = { ...clientCfg, ...pickLedger(base.autoSpend) }
  if (!isOn(pa) && isOn(cfg)) cfg = resumeAutoSpend(cfg, now)
  const out: SiteState = {
    ...next,
    balance: clampBalance(base.balance + balanceDelta),
    autoSpend: cfg,
  }
  // TZ moved forward past midnight → the banked day is over: close it now.
  return rolloverAutoSpend(out, now) ?? out
}

/* ------------------------- Ledger period projection ---------------------- */

type Acc = Map<
  string,
  { cost: number; shows: number; clicks: number; goals: number; revenue: number; bw: number }
>

function accAdd(acc: Acc, map: Record<string, DayMetrics> | undefined): void {
  if (!map) return
  for (const [id, m] of Object.entries(map)) {
    const t = acc.get(id) ?? { cost: 0, shows: 0, clicks: 0, goals: 0, revenue: 0, bw: 0 }
    t.cost += m.cost
    t.shows += m.shows
    t.clicks += m.clicks
    t.goals += m.goals
    t.revenue += m.revenue
    t.bw += m.bounce * m.cost
    acc.set(id, t)
  }
}

function ledgerPeriod(
  state: SiteState,
  period: SitePeriod,
  now: Date,
  today: ReturnType<typeof liveToday>,
): Acc {
  const a = state.autoSpend as AutoSpend
  const acc: Acc = new Map()
  if (period === 'today') {
    accAdd(acc, today.campaigns)
    return acc
  }
  if (period === 'yesterday') {
    accAdd(acc, ledgerDay(state, shiftDay(today.key, -1), today.key)?.campaigns)
    return acc
  }
  if (period === 'week' || period === 'month') {
    const span = period === 'week' ? 7 : 30
    for (let i = 1; i < span; i++) {
      accAdd(acc, ledgerDay(state, shiftDay(today.key, -i), today.key)?.campaigns)
    }
  } else {
    accAdd(acc, a.archive)
    for (const [k, rec] of Object.entries(a.days ?? {})) {
      if (k < today.key) accAdd(acc, rec.campaigns)
    }
    const L = a.lastCommittedDay
    if (L && L < today.key) {
      const n = Math.min(daysBetween(L, today.key), MAX_ROLLOVER_DAYS)
      for (let j = 0; j < n; j++) {
        const d = shiftDay(L, j)
        if (!a.days?.[d]) accAdd(acc, ledgerDay(state, d, today.key)?.campaigns)
      }
    }
  }
  accAdd(acc, today.campaigns)
  return acc
}

function projectLedgerCampaign(
  c: SiteCampaign,
  t: ReturnType<Acc['get']>,
  on: boolean,
): SiteCampaign {
  if (t) {
    return {
      ...c,
      cost: round2(t.cost),
      shows: Math.round(t.shows),
      clicks: Math.round(t.clicks),
      goals: Math.round(t.goals),
      revenue: round2(t.revenue),
      bounce: round2(t.cost > 0 ? Math.min(100, t.bw / t.cost) : 0),
    }
  }
  // Running under auto-spend but nothing in the ledger for this period
  // (e.g. added today, viewing «Вчера») — it genuinely spent nothing.
  if (on && c.status === 'running') {
    return { ...c, ...ZERO_METRICS }
  }
  return c // stopped / auto off: hand-edited numbers, as before
}

/**
 * Balance exactly as the vitrine shows it right now: stored balance minus
 * today's live partial spend. Reuses the same simulation stateForPeriod
 * ('today') runs, so the panel can never disagree with the page.
 */
export function liveBalance(state: SiteState, now: Date = new Date()): number {
  const a = state.autoSpend
  if (a?.historyFrom) {
    return round2(Math.max(0, state.balance - liveToday(state, now).delta))
  }
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
  if (auto?.historyFrom) {
    // Ledger mode: frozen history + today's bank and live delta — also while
    // auto-spend is OFF, so disabling never wipes what was already shown.
    const today = liveToday(state, now)
    balance = round2(Math.max(0, state.balance - today.delta))
    const acc = ledgerPeriod(state, period, now, today)
    const on = isOn(auto)
    campaigns = state.campaigns.map((c) =>
      projectLedgerCampaign(c, acc.get(c.id), on),
    )
  } else if (auto?.enabled && auto.dailyBudget > 0) {
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
    // Blocked accounts still ship the full contract payload (harmless — the
    // page wipes itself before rendering any of it), so a vitrine built
    // before this flag existed keeps working untouched.
    ...(state.blocked ? { blocked: true as const } : {}),
  }
}
