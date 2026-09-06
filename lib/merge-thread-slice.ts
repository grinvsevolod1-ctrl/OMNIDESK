import type { Message } from '@/lib/types'

/** Optimistic bubbles created by the composer before the server confirms. */
const OPTIMISTIC_PREFIX = 'tmp_'

function isOptimistic(m: Message): boolean {
  return m.id.startsWith(OPTIMISTIC_PREFIX)
}

/**
 * Reconcile a fresh server slice of ONE thread with what the client already
 * holds for it.
 *
 * Every `router.refresh()` (debounced realtime tick for ANY dialog, reconnect,
 * status change…) re-ships only the newest ~30 messages per preloaded thread.
 * The local cache, however, may hold hundreds of OLDER messages the reader
 * loaded on demand («Загрузить ранние сообщения», cold-thread hydration).
 *
 * Replacing the cache wholesale — the previous behaviour — threw that history
 * away on every tick: the scroll container collapsed from 300 messages to 30
 * under the reader, the browser clamped scrollTop to what was left, and they
 * landed at the top of the thread mid-sentence. That was the «кидает в начало
 * диалога» bug, and it looked random because the trigger was activity in
 * unrelated dialogs.
 *
 * Rules:
 *  - fresh is authoritative for its own time range and everything after it
 *    (edits, reactions, delivery status, soft-deletes, the real row behind an
 *    optimistic bubble all arrive through it);
 *  - local messages that PRECEDE the fresh slice are kept untouched;
 *  - optimistic `tmp_` bubbles never survive a refresh — the refresh that
 *    follows a send carries the real row, which is exactly how they were
 *    retired before this helper existed.
 */
export function mergeFreshSlice(
  local: Message[] | undefined,
  fresh: Message[],
): Message[] {
  if (!local || local.length === 0) return fresh
  if (fresh.length === 0) return fresh

  const freshIds = new Set(fresh.map((m) => m.id))
  // Position-based split: everything before the first local message that the
  // fresh slice also contains is older history. Position (not timestamp) so a
  // slice boundary falling between two messages with the same created_at
  // cannot swallow the earlier one.
  const overlapIndex = local.findIndex((m) => freshIds.has(m.id))
  let older: Message[]
  if (overlapIndex >= 0) {
    older = local.slice(0, overlapIndex)
  } else {
    // Disjoint (cache far behind the server): keep only what is strictly
    // older than the slice; anything in or after its range is stale.
    const head = Date.parse(fresh[0].createdAt)
    older = local.filter((m) => Date.parse(m.createdAt) < head)
  }
  older = older.filter((m) => !freshIds.has(m.id) && !isOptimistic(m))
  return older.length === 0 ? fresh : [...older, ...fresh]
}

/**
 * Apply a fresh `messagesByConversation` map (SSR props) over the local cache.
 * Threads absent from the fresh map (outside the preload slice, or empty) are
 * left exactly as they are — a hydrated 300-message thread must not vanish
 * just because the server did not re-ship it.
 */
export function mergeFreshSlices(
  local: Record<string, Message[]>,
  fresh: Record<string, Message[]>,
): Record<string, Message[]> {
  const next: Record<string, Message[]> = { ...local }
  for (const [id, slice] of Object.entries(fresh)) {
    next[id] = mergeFreshSlice(local[id], slice)
  }
  return next
}
