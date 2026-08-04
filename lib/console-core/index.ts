import 'server-only'

/**
 * Shared core for the conversational consoles (admin OS shell copilot in
 * lib/admin-console and the servers assistant in lib/servers-console).
 * Both consoles previously kept private copies of these utilities that had
 * already started to drift (history compression existed only in one).
 * Domain logic — tools, prompts, intents — stays in each console; only the
 * pure, behaviour-critical plumbing lives here.
 */

export interface NormalizedTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Turns beyond this tail are aggressively truncated (context compression). */
const RECENT_TURNS_FULL = 6
/** Older turns keep only this many characters — enough to preserve context. */
const OLD_TURN_CHARS = 280
/** Hard cap per turn even in the recent window. */
const TURN_CHARS = 2000

/**
 * Normalize raw client history into clean model turns.
 * Cost control: only the last RECENT_TURNS_FULL turns keep their full text
 * (up to TURN_CHARS); older turns are compressed to OLD_TURN_CHARS. Long
 * dialogs keep the model's context useful while the per-request token bill
 * stays roughly constant instead of growing with the conversation.
 */
export function normalizeTurns(
  history: Array<{ role: string; content: unknown }> | undefined,
  historyLimit: number,
): NormalizedTurn[] {
  const turns = (history ?? [])
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .slice(-historyLimit) as Array<{ role: string; content: string }>
  const cutoff = Math.max(0, turns.length - RECENT_TURNS_FULL)
  return turns.map((t, i) => {
    const full = t.content.trim().slice(0, TURN_CHARS)
    const content =
      i < cutoff && full.length > OLD_TURN_CHARS
        ? `${full.slice(0, OLD_TURN_CHARS - 1)}…`
        : full
    return {
      role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content,
    }
  })
}

/** The latest user utterance from a normalized turn list. */
export function lastUserText(turns: NormalizedTurn[]): string {
  return [...turns].reverse().find((t) => t.role === 'user')?.content ?? ''
}

/**
 * Wrap every tool so its start is reported through `onStatus` (SSE `status`
 * frames) using per-console label maps. Purely additive: without a callback
 * the tools are untouched.
 */
export function withStatus<T extends Record<string, unknown>>(
  tools: T,
  labels: Record<string, string>,
  onStatus?: (label: string) => void,
): T {
  if (!onStatus) return tools
  for (const [name, t] of Object.entries(tools)) {
    const candidate = t as { execute?: (...args: never[]) => unknown }
    const orig = candidate.execute
    if (typeof orig !== 'function') continue
    candidate.execute = (...args: never[]) => {
      try {
        onStatus(labels[name] ?? 'Собираю данные…')
      } catch {
        // A broken status sink must never break the tool itself.
      }
      return orig.apply(candidate, args)
    }
  }
  return tools
}

/* --------------------------- TTL tool cache --------------------------- */

const CACHE_TTL_MS = 30_000
const MAX_ENTRIES = 50

const store = new Map<string, { value: unknown; expires: number }>()

/**
 * Tiny in-memory TTL cache for read-only console tools. Summary stats and
 * statuses change slowly, but admins ask for them constantly — a short TTL
 * removes repeated DB round-trips inside a turn (the model often re-checks
 * data) and across rapid consecutive questions, cutting latency.
 *
 * Deliberately process-local and tiny: on serverless the worst case is a
 * cold cache, never stale-forever data. Mutating tools don't need to
 * invalidate — entries die on their own within CACHE_TTL_MS.
 */
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
