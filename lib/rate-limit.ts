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

/**
 * Cap on tracked keys. A distributed flood with unique keys must not be able
 * to leak memory — but it must not be able to RESET everyone's counters
 * either. (An earlier version called `buckets.clear()` at the cap, which let
 * an attacker flush login-throttle state for every client by flooding unique
 * keys. Eviction now targets soonest-to-expire entries instead.)
 */
const MAX_BUCKETS = 100_000

/** Drop every expired bucket. Cheap and amortized — runs at most once a minute. */
function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
  if (buckets.size <= MAX_BUCKETS) return

  // Still over cap after dropping expired entries: evict the buckets closest
  // to their natural expiry (they carry the least remaining signal), keeping
  // fresh windows — e.g. an in-progress login ban — intact. One O(n log n)
  // pass down to 90% of cap, amortized behind the once-a-minute sweep.
  const byExpiry = [...buckets.entries()].sort(
    (a, b) => a[1].resetAt - b[1].resetAt,
  )
  const target = Math.floor(MAX_BUCKETS * 0.9)
  for (let i = 0; i < byExpiry.length && buckets.size > target; i++) {
    buckets.delete(byExpiry[i]![0])
  }
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

/* ------------------------ Multi-process correctness ----------------------- */

/**
 * The in-memory store is only correct for a SINGLE process: with N instances
 * each counts independently and every limit silently multiplies by N —
 * including login brute-force protection. That is a security regression, not
 * just an accuracy issue, so it must never happen quietly.
 *
 * Detection: pm2 cluster mode runs the app as Node `cluster` workers, so
 * `cluster.isWorker` is true there and ONLY there. (NODE_APP_INSTANCE is NOT
 * a valid signal — pm2 sets it even for a single fork-mode process, which
 * would false-positive every standard single-instance deploy and block
 * logins.) Deployments can also assert the requirement explicitly with
 * RATE_LIMIT_REQUIRE_REDIS=true (recommended for any load-balanced setup pm2
 * can't see, e.g. two VPSes behind one nginx).
 *
 * Policy: production + multi-process + no Redis = FAIL FAST at first use, so
 * the misconfiguration is caught at deploy time rather than discovered during
 * an attack. Dev/preview logs loudly instead of refusing to boot.
 */
let multiProcessChecked = false
function assertMultiProcessSafety(): void {
  if (multiProcessChecked || redisConfigured()) return
  multiProcessChecked = true

  // `cluster.isWorker` is true only when the process was forked by the Node
  // cluster module — exactly what pm2 cluster mode does. Guarded with a
  // try/require so runtimes without node:cluster never crash here.
  let inPm2Cluster = false
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCluster = require('node:cluster') as { isWorker?: boolean }
    inPm2Cluster = nodeCluster.isWorker === true
  } catch {
    inPm2Cluster = false
  }
  const explicitlyRequired = process.env.RATE_LIMIT_REQUIRE_REDIS === 'true'
  if (!inPm2Cluster && !explicitlyRequired) return

  const message =
    '[rate-limit] Multiple app instances detected ' +
    (inPm2Cluster ? '(pm2 cluster mode)' : '(RATE_LIMIT_REQUIRE_REDIS=true)') +
    ' but no shared Redis store is configured. In-memory rate limiting is ' +
    'INCORRECT across instances: every limit (including login brute-force ' +
    'protection) multiplies by the instance count. Set UPSTASH_REDIS_REST_URL ' +
    '+ UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_*), or run a single instance.'

  if (process.env.NODE_ENV === 'production') {
    throw new Error(message)
  }
  console.error(message)
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
  assertMultiProcessSafety()
  if (redisConfigured()) {
    const viaRedis = await redisRateLimit(key, limit, windowMs)
    if (viaRedis) return viaRedis
    // Redis hiccup: fall through to the in-memory counter (fail safe/closed-ish
    // — still enforced on this instance — rather than allowing the request).
  }
  return memoryRateLimit(key, limit, windowMs)
}
