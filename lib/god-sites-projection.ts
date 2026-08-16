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
  AutoSpend,
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
