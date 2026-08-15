/**
 * Pure auto-spend curve math for god-panel managed sites ("Сайты" tab).
 *
 * Extracted from lib/god-sites.ts (server-only) so the god-panel editor can
 * render the "к этому часу скручено ~N%" preview from the SAME curve the
 * server uses — previously the editor kept a hand-copied mirror that would
 * silently drift when the server curve changed.
 *
 * NO imports, NO 'server-only': everything here is a pure function of its
 * arguments, safe for both server routes and client components.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only. Never import this from
 * regular admin/manager/curator code or from lib/ai-console.
 */

/** Hourly traffic weights 00→23: night lull, day plateau, evening peak. */
export const HOUR_WEIGHTS = [
  2, 1, 1, 1, 1, 2, 4, 7, 10, 12, 13, 13, 12, 12, 12, 12, 13, 14, 15, 14, 11,
  8, 5, 3,
]
const HOUR_TOTAL = HOUR_WEIGHTS.reduce((a, b) => a + b, 0)
/** Cumulative curve: HOUR_CUM[h] = share of the day spent by hour h. */
const HOUR_CUM = HOUR_WEIGHTS.reduce<number[]>((acc, w, i) => {
  acc.push((i > 0 ? acc[i - 1] : 0) + w / HOUR_TOTAL)
  return acc
}, [])

/** FNV-1a → [0, 1). Deterministic per-seed jitter, stable across processes. */
export function seededUnit(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}

/** Jitter multiplier in [1-spread, 1+spread], deterministic per seed. */
export function jitter(seed: string, spread: number): number {
  return 1 + (seededUnit(seed) * 2 - 1) * spread
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Calendar day key (YYYY-MM-DD) in the panel's auto-spend timezone. */
export function autoDayKey(now: Date, tzOffsetHours: number): string {
  const shifted = new Date(now.getTime() + tzOffsetHours * 3_600_000)
  return shifted.toISOString().slice(0, 10)
}

/** Share of the daily budget burnt by `now` — cumulative traffic curve. */
export function autoDayFraction(now: Date, tzOffsetHours: number): number {
  const shifted = new Date(now.getTime() + tzOffsetHours * 3_600_000)
  const h = shifted.getUTCHours()
  const minuteShare =
    (shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds()) / 3_600
  const prev = h > 0 ? HOUR_CUM[h - 1] : 0
  return Math.min(1, prev + (HOUR_CUM[h] - prev) * minuteShare)
}

/* ------------------------- Day-shape profiles --------------------------- */

/**
 * Preset day shapes for the spend curve. Hourly weights 00→23; each is
 * normalized at use so only the SHAPE matters, not the absolute numbers.
 *  - standard: night lull, day plateau, evening peak (the historical curve)
 *  - morning:  ramp starts at 6-7, peak 9-13, fades after 18
 *  - evening:  slow day, climb from 16, peak 19-23
 *  - always:   near-flat 24/7 (api/retail that never sleeps)
 */
export type SpendProfile = 'standard' | 'morning' | 'evening' | 'always'

export const SPEND_PROFILES: Record<SpendProfile, readonly number[]> = {
  standard: HOUR_WEIGHTS,
  morning: [
    1, 1, 1, 1, 2, 4, 8, 12, 15, 16, 16, 15, 14, 12, 10, 8, 7, 6, 4, 3, 2, 2,
    1, 1,
  ],
  evening: [
    3, 2, 1, 1, 1, 1, 2, 3, 4, 5, 6, 6, 7, 7, 8, 9, 11, 13, 15, 16, 16, 14,
    10, 6,
  ],
  always: [
    8, 8, 8, 8, 8, 8, 9, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 9,
    9, 8, 8,
  ],
}

/**
 * Cumulative share of the daily budget burnt by `now`, shaped by a profile
 * and smoothed into an S-curve.
 *
 * `smoothness` 0..1 blends between the historical step-rate curve (0 — each
 * hour burns at a constant rate, visible "corners" at hour boundaries) and a
 * cosine-interpolated rate (1 — the burn rate glides between hourly weights,
 * so mornings wake up gradually and nights taper off instead of snapping).
 * Integrated numerically at 5-minute resolution — cheap (288 steps) and
 * exact enough that the curve always ends the day at precisely 1.
 *
 * Deterministic pure math: server routes, commit math and the editor preview
 * all agree. Callers without a profile keep using autoDayFraction — byte-for-
 * byte the historical behaviour.
 */
export function dayCurveFraction(
  now: Date,
  tzOffsetHours: number,
  profile: SpendProfile,
  smoothness: number,
): number {
  const shifted = new Date(now.getTime() + tzOffsetHours * 3_600_000)
  const hourFloat =
    shifted.getUTCHours() +
    (shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds()) / 3_600
  return dayCurveAt(hourFloat, profile, smoothness)
}

/** Same curve addressed by hour-of-day [0..24) — used by the UI preview. */
export function dayCurveAt(
  hourFloat: number,
  profile: SpendProfile,
  smoothness: number,
): number {
  const weights = SPEND_PROFILES[profile] ?? SPEND_PROFILES.standard
  const s = Math.max(0, Math.min(1, smoothness))
  const target = Math.max(0, Math.min(24, hourFloat))
  // Integer step indexing (t = i/12), NOT `t += 1/12` accumulation — float
  // drift over 288 additions pushes the last step into the partial branch
  // and the day would end at ≈0.9987 instead of exactly 1.
  const STEPS = 288 // 5-minute grid
  const STEP = 24 / STEPS
  let total = 0
  let upTo = 0
  for (let i = 0; i < STEPS; i++) {
    const t = i * STEP
    const r = blendedRate(weights, t + STEP / 2, s)
    total += r
    if (t + STEP <= target) {
      upTo += r
    } else if (t < target) {
      upTo += r * ((target - t) / STEP)
    }
  }
  return total > 0 ? Math.min(1, upTo / total) : 0
}

/** Burn rate at an exact hour: step weight blended with cosine interpolation. */
function blendedRate(
  weights: readonly number[],
  hourFloat: number,
  smoothness: number,
): number {
  const h = Math.min(23, Math.floor(hourFloat))
  const step = weights[h]
  if (smoothness === 0) return step
  // Treat weights as samples at hour centers (h + 0.5) and cosine-slide
  // between neighbours; the day wraps so 23:30 flows into 00:30.
  const pos = hourFloat - 0.5
  const i0 = ((Math.floor(pos) % 24) + 24) % 24
  const i1 = (i0 + 1) % 24
  const frac = pos - Math.floor(pos)
  const eased = (1 - Math.cos(frac * Math.PI)) / 2
  const smooth = weights[i0] + (weights[i1] - weights[i0]) * eased
  return step + (smooth - step) * smoothness
}

/** Default weekend dip strength (Sun −dip, Sat −dip·0.75, Fri −dip·0.25). */
export const DEFAULT_WEEKEND_DIP = 0.18
/** Default deterministic day-to-day jitter amplitude. */
export const DEFAULT_DAY_JITTER = 0.06

/**
 * Weekly rhythm multiplier for a day's effective budget: real ad traffic dips
 * on weekends and eases off on Friday. Deterministic from the date alone so
 * every reader agrees. `dip` scales the effect: at the default 0.18 —
 * Sun ≈ 0.82, Sat ≈ 0.865, Fri ≈ 0.955, Mon–Thu = 1; at 0 the week is flat.
 */
export function weekdayFactor(
  dayKey: string,
  dip: number = DEFAULT_WEEKEND_DIP,
): number {
  const t = Date.parse(`${dayKey}T00:00:00Z`)
  if (!Number.isFinite(t)) return 1
  const d = Math.max(0, Math.min(0.5, dip))
  const dow = new Date(t).getUTCDay() // 0 = Sunday … 6 = Saturday
  if (dow === 0) return 1 - d
  if (dow === 6) return 1 - d * 0.75
  if (dow === 5) return 1 - d * 0.25
  return 1
}

/** Whole days between two YYYY-MM-DD keys (0 when equal or unparsable). */
export function daysBetween(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`)
  const to = Date.parse(`${toKey}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, Math.round((to - from) / 86_400_000))
}
