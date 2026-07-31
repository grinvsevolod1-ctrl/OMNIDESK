import { revalidateTag, unstable_cache } from 'next/cache'

/** Single tag every cached analytics reader is registered under. */
const ANALYTICS_TAG = 'analytics'

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
    tags: [ANALYTICS_TAG],
  }) as (...args: A) => Promise<R>
}

/**
 * Drop every cached analytics rollup. Call this from server actions that mutate
 * data the dashboards aggregate (lead status/assignment changes, conversation
 * or message writes) so the next dashboard read reflects the change instead of
 * waiting out the TTL. Safe to call even when caching is disabled (TTL 0): no
 * entries are tagged, so the invalidation is a cheap no-op.
 *
 * The `'max'` profile is Next 16's required stale-while-revalidate hint: readers
 * keep serving the previous rollup while the fresh one recomputes in the
 * background, so a burst of dashboard loads right after a mutation never all
 * block on the same heavy query.
 */
export function invalidateAnalytics(): void {
  if (ANALYTICS_TTL_SECONDS <= 0) return
  revalidateTag(ANALYTICS_TAG, 'max')
}
