import 'server-only'

/**
 * Tiny in-memory TTL cache for read-only copilot tools. Summary stats and
 * account statuses change slowly, but admins ask for them constantly — a
 * short TTL removes repeated DB round-trips inside a turn (the model often
 * re-checks data) and across rapid consecutive questions, cutting latency.
 *
 * Deliberately process-local and tiny: on serverless the worst case is a
 * cold cache, never stale-forever data. Mutating tools don't need to
 * invalidate — entries die on their own within CACHE_TTL_MS.
 */
const CACHE_TTL_MS = 30_000
const MAX_ENTRIES = 50

const store = new Map<string, { value: unknown; expires: number }>()

/** Get `key` from cache or compute (and cache) it. */
export async function cached<T>(
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && hit.expires > now) return hit.value as T
  const value = await compute()
  if (store.size >= MAX_ENTRIES) {
    // Evict expired first; if none, drop the oldest insertion.
    for (const [k, v] of store) {
      if (v.expires <= now) store.delete(k)
    }
    if (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next().value
      if (oldest !== undefined) store.delete(oldest)
    }
  }
  store.set(key, { value, expires: now + CACHE_TTL_MS })
  return value
}
