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

/**
 * Weekly rhythm multiplier for a day's effective budget: real ad traffic dips
 * on weekends and eases off on Friday. Deterministic from the date alone so
 * every reader agrees. Sun ≈ 0.80, Sat ≈ 0.85, Fri ≈ 0.95, Mon–Thu = 1.
 */
export function weekdayFactor(dayKey: string): number {
  const t = Date.parse(`${dayKey}T00:00:00Z`)
  if (!Number.isFinite(t)) return 1
  const dow = new Date(t).getUTCDay() // 0 = Sunday … 6 = Saturday
  if (dow === 0) return 0.8
  if (dow === 6) return 0.85
  if (dow === 5) return 0.95
  return 1
}

/** Whole days between two YYYY-MM-DD keys (0 when equal or unparsable). */
export function daysBetween(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`)
  const to = Date.parse(`${toKey}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, Math.round((to - from) / 86_400_000))
}
