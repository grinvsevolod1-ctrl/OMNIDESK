/**
 * In-memory fixed-window rate limiter.
 *
 * The panel runs as a single long-lived Node process on a VPS, so a
 * module-level Map is a correct and fast store for per-key counters — no Redis
 * round-trip on the hot path of the public live-chat endpoints. (If this app is
 * ever scaled to multiple processes, swap this module for a shared store; every
 * call site goes through `rateLimit()` so only this file changes.)
 *
 * Each key gets a counter that resets at a fixed interval. Expired buckets are
 * swept lazily so memory stays bounded even under a flood of unique keys
 * (e.g. spoofed visitor ids).
 */

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
let lastSweep = Date.now()

/** Drop every expired bucket. Cheap and amortized — runs at most once a minute. */
function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
  // Hard cap: if something pathological blows the map up, reset it wholesale
  // rather than leak memory. Counters resetting early is harmless.
  if (buckets.size > 100_000) buckets.clear()
}

export interface RateResult {
  /** False when the caller has exceeded `limit` within the current window. */
  allowed: boolean
  /** Remaining allowance in this window (0 when blocked). */
  remaining: number
  /** Seconds until the window resets — surface as Retry-After when blocked. */
  retryAfterSec: number
}

/**
 * Count one hit against `key` and report whether it's within `limit` per
 * `windowMs`. Always counts the hit (so sustained abuse keeps tripping), which
 * is the desired behaviour for flood protection.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateResult {
  const now = Date.now()
  if (now - lastSweep > 60_000) {
    sweep(now)
    lastSweep = now
  }

  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
    buckets.set(key, bucket)
  }

  bucket.count += 1
  const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))

  if (bucket.count > limit) {
    return { allowed: false, remaining: 0, retryAfterSec }
  }
  return { allowed: true, remaining: limit - bucket.count, retryAfterSec }
}
