import 'server-only'

import {
  commitAutoSpend,
  getSiteBySlugAndKey,
  type GodSite,
} from '@/lib/god-sites'

/**
 * Shared per-site poller for the SSE endpoint.
 *
 * Every open stream used to run its own `setInterval` re-resolving the site
 * from the DB every few seconds. With several tabs/viewers on the same vitrine
 * that meant N identical `getSiteBySlugAndKey` reads (plus N `commitAutoSpend`
 * writes at day rollover) every tick. Here we fan a SINGLE poll out to all
 * subscribers that share the same (slug, token).
 *
 * Keying on slug+token — rather than slug alone — keeps the exact revocation
 * semantics of the old per-connection poll with zero changes to god-sites: a
 * site has effectively one valid token, so legitimate viewers still collapse
 * onto one poller, while a rotated/deleted key makes the shared poll return
 * null and every subscriber is told to close. Period projection stays
 * per-connection (it is a pure function of the shared `GodSite`).
 */

const DB_POLL_MS = 3_000

/** `null` means the site is gone/revoked — subscribers must close. */
type Subscriber = (site: GodSite | null) => void

interface Poller {
  subscribers: Set<Subscriber>
  timer: ReturnType<typeof setInterval>
}

const pollers = new Map<string, Poller>()

// NUL is not valid in a slug or token, so it is a safe composite-key separator.
const SEP = '\u0000'

async function tick(key: string): Promise<void> {
  const poller = pollers.get(key)
  if (!poller || poller.subscribers.size === 0) return
  const sepAt = key.indexOf(SEP)
  const slug = key.slice(0, sepAt)
  const token = key.slice(sepAt + 1)
  try {
    // Re-resolving by slug+key each tick doubles as live revocation: a
    // rotated/deleted key resolves to null and every subscriber closes.
    const found = await getSiteBySlugAndKey(slug, token, { touch: true })
    const fresh = found ? await commitAutoSpend(found) : null
    // The poller may have been torn down while we awaited.
    const current = pollers.get(key)
    if (!current) return
    // Snapshot the set: a subscriber may unsubscribe from inside its callback
    // (e.g. on revocation), which mutates the live set mid-iteration.
    for (const sub of [...current.subscribers]) {
      try {
        sub(fresh)
      } catch {
        /* a broken subscriber must not stop the fan-out to the others */
      }
    }
  } catch {
    /* transient DB error — keep the poller and retry on the next tick */
  }
}

/**
 * Subscribe to live updates for (slug, token). `onUpdate` fires once per poll
 * with the fresh site, or `null` when the key no longer resolves. Returns an
 * unsubscribe fn; the underlying timer is ref-counted and cleared when the
 * last subscriber for that key leaves.
 */
export function subscribeSite(
  slug: string,
  token: string,
  onUpdate: Subscriber,
): () => void {
  const key = `${slug}${SEP}${token}`
  let poller = pollers.get(key)
  if (!poller) {
    poller = {
      subscribers: new Set(),
      timer: setInterval(() => {
        void tick(key)
      }, DB_POLL_MS),
    }
    pollers.set(key, poller)
  }
  poller.subscribers.add(onUpdate)

  return () => {
    const p = pollers.get(key)
    if (!p) return
    p.subscribers.delete(onUpdate)
    if (p.subscribers.size === 0) {
      clearInterval(p.timer)
      pollers.delete(key)
    }
  }
}
