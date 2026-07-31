/**
 * Fixed-window rate limiter with a pluggable backing store.
 *
 * By default the panel runs as a single long-lived Node process on a VPS, so a
 * module-level Map is a correct and fast store for per-key counters — no network
 * round-trip on the hot path of the public live-chat endpoints.
 *
 * When the app is scaled to MULTIPLE processes/instances, an in-memory Map would
 * let each instance count independently (so the effective limit multiplies by
 * the instance count). To stay correct under horizontal scaling, set
 * `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or the `KV_REST_API_*`
 * equivalents) and this module transparently switches to a shared Redis counter
 * via Upstash's REST API — no extra npm dependency, just `fetch`. If Redis is
 * unreachable for a given call we fail SAFE by falling back to the in-memory
 * counter, so the endpoint stays protected rather than open.
 *
 * Every call site goes through the async `rateLimit()` below, so swapping stores
 * never touches callers.
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
 * In-memory fixed-window counter. Always counts the hit (so sustained abuse
 * keeps tripping), which is the desired behaviour for flood protection. This is
 * the default store and the fallback when Redis is configured but unreachable.
 */
function memoryRateLimit(
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

/* --------------------------- Shared Redis store --------------------------- */

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? ''
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? ''

/** True when a shared Redis store is configured via env. */
function redisConfigured(): boolean {
  return REDIS_URL !== '' && REDIS_TOKEN !== ''
}

/**
 * Fixed-window counter backed by Upstash Redis over its REST API. A single
 * pipelined round-trip: INCR the key, arm its TTL only on the first hit
 * (PEXPIRE ... NX), and read the remaining TTL for Retry-After. Returns null on
 * any error so the caller can fall back to the in-memory store.
 */
async function redisRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateResult | null> {
  const redisKey = `rl:${key}`
  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${REDIS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', redisKey],
        ['PEXPIRE', redisKey, windowMs, 'NX'],
        ['PTTL', redisKey],
      ]),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json()) as Array<{ result?: number; error?: string }>
    if (!Array.isArray(data) || data[0]?.result == null) return null

    const count = Number(data[0].result)
    let ttlMs = Number(data[2]?.result)
    // PTTL returns -1 (no expiry) / -2 (missing) in edge races; treat as a full
    // fresh window rather than a negative Retry-After.
    if (!Number.isFinite(ttlMs) || ttlMs < 0) ttlMs = windowMs
    const retryAfterSec = Math.max(1, Math.ceil(ttlMs / 1000))

    if (count > limit) return { allowed: false, remaining: 0, retryAfterSec }
    return { allowed: true, remaining: Math.max(0, limit - count), retryAfterSec }
  } catch {
    return null
  }
}

/**
 * Count one hit against `key` and report whether it's within `limit` per
 * `windowMs`. Uses the shared Redis store when configured (correct across
 * multiple instances), otherwise the in-memory store; falls back to in-memory if
 * a Redis call fails so the endpoint is never left unprotected.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateResult> {
  if (redisConfigured()) {
    const viaRedis = await redisRateLimit(key, limit, windowMs)
    if (viaRedis) return viaRedis
    // Redis hiccup: fall through to the in-memory counter (fail safe/closed-ish
    // — still enforced on this instance — rather than allowing the request).
  }
  return memoryRateLimit(key, limit, windowMs)
}
