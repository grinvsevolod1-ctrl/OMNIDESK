/**
 * Per-key task serialization shared by the job queue AND the session registry.
 *
 * Everything that drives one Telegram channel's MTProto session — queued jobs
 * (login steps, sends), the auto-revival sweep, and startup restore — MUST go
 * through the same chain. Previously the sweep/restore called start() directly
 * while a queued job could be mid-flight on the same session, racing two
 * connects/sends through one client (disconnects mid-send, and behaviour
 * Telegram reads as bot-like). Keys serialize independently: different
 * channels still run fully in parallel.
 *
 * The map holds each key's queue tail; entries are pruned when the tail
 * settles so the map cannot grow unboundedly.
 */
const tails = new Map<string, Promise<void>>()

export function runSerialized<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  // Run after the previous task settles, regardless of its outcome.
  const result = prev.then(task, task)
  // The stored tail swallows the outcome so one failed task can never poison
  // the chain for later tasks (each caller still gets the real result above).
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  tails.set(key, tail)
  void tail.finally(() => {
    // Prune only if we are still the tail (nothing queued behind us).
    if (tails.get(key) === tail) tails.delete(key)
  })
  return result
}
