import { unstable_cache } from 'next/cache'

/**
 * Time-based cache for analytics dashboard rollups.
 *
 * These reads are heavy (per-conversation first-contact aggregation, date-range
 * COUNTs across the whole messages table) and their results do NOT need to be
 * second-accurate — a dashboard that is at most a minute stale is perfectly
 * fine, and it collapses a burst of admins/managers opening the same report into
 * a single database hit. TTL is tunable per deployment via ANALYTICS_CACHE_TTL
 * (seconds); set to 0 to disable caching entirely. Default 60s.
 */
export const ANALYTICS_TTL_SECONDS = (() => {
  const raw = Number.parseInt(process.env.ANALYTICS_CACHE_TTL || '', 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : 60
})()

/**
 * Wrap a pure, argument-keyed analytics reader in Next's data cache. The
 * function MUST derive its result solely from its arguments (no cookies/headers)
 * — every analytics reader here is already manager/group-scoped through explicit
 * id + date-range params, so the arguments fully determine the cache key.
 *
 * When TTL is 0 the original function is returned unwrapped so callers always
 * hit the database.
 */
export function cachedAnalytics<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  keyParts: string[],
): (...args: A) => Promise<R> {
  if (ANALYTICS_TTL_SECONDS <= 0) return fn
  return unstable_cache(fn, keyParts, {
    revalidate: ANALYTICS_TTL_SECONDS,
    tags: ['analytics'],
  }) as (...args: A) => Promise<R>
}
