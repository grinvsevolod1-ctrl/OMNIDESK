/**
 * Pure SVG-path and axis math shared by the analytics charts (per-day stacked
 * area, per-hour line). No React here — extracted from activity-chart.tsx.
 */

/** Build a smooth cubic-Bézier path through points using Catmull-Rom. */
export function smoothPath(
  points: readonly (readonly [number, number])[],
): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`
  }
  return d
}

/** Smooth filled band between a lower and an upper boundary (both point arrays). */
export function areaBetween(
  lower: readonly (readonly [number, number])[],
  upper: readonly (readonly [number, number])[],
): string {
  if (!upper.length) return ''
  const topCurve = smoothPath(upper)
  const bottomCurve = smoothPath([...lower].reverse()).replace(/^M/, 'L')
  return `${topCurve} ${bottomCurve} Z`
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Round a max value up to a clean axis ceiling (1, 2, 5, 10, 20, 50…). */
export function niceCeil(n: number): number {
  if (n <= 1) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(n)))
  const frac = n / pow
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10
  return nice * pow
}

/** Up to 5 evenly spaced whole-number ticks from 0 to top (descending). */
export function axisTicks(top: number): number[] {
  const steps = Math.min(top, 4)
  const out: number[] = []
  for (let i = steps; i >= 0; i--) out.push(Math.round((top / steps) * i))
  return [...new Set(out)]
}

/** «пн 3» — short weekday + day-of-month label for an ISO date. */
export function dayTick(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00')
  return `${d.toLocaleDateString('ru-RU', { weekday: 'short' })} ${d.getDate()}`
}
