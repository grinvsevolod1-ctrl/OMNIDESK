'use client'

import { useEffect, useRef } from 'react'

/**
 * Shared background poller (generic sibling of use-channel-status).
 *
 * Guarantees per key:
 *   • ONE interval regardless of how many components subscribe — several open
 *     views (tabs within the panel, duplicated sections) no longer multiply
 *     the server-action load;
 *   • no stacked requests: a tick is skipped while the previous one is still
 *     in flight (a slow server used to accumulate overlapping 5s requests);
 *   • hidden tabs don't poll — the first visible tick catches up.
 *
 * The tick callback is read through a ref, so an unstable closure (filters,
 * offsets captured per render) never restarts the interval.
 */

type Tick = () => Promise<void>

interface Channel {
  subs: Set<{ current: Tick }>
  timer: ReturnType<typeof setInterval>
  inFlight: boolean
}

const channels = new Map<string, Channel>()

async function runTick(ch: Channel): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden) return
  if (ch.inFlight) return
  ch.inFlight = true
  try {
    // Each subscriber polls its own action/params; run them together.
    await Promise.all(
      Array.from(ch.subs, (ref) =>
        ref.current().catch(() => {
          // Transient failure — the next tick retries.
        }),
      ),
    )
  } finally {
    ch.inFlight = false
  }
}

/**
 * Run a channel's tick immediately, outside its interval — the push half of
 * the poll/push hybrid: an SSE event (new lead, resync) pokes the existing
 * poller instead of duplicating its fetch logic. All guarantees hold: no
 * stacked requests (in-flight tick absorbs the poke), hidden tabs stay
 * silent, unknown keys are a no-op (the view simply isn't mounted).
 */
export function pokeSharedPoll(key: string): void {
  const ch = channels.get(key)
  if (ch) void runTick(ch)
}

/**
 * Poll `tick` every `intervalMs` on the shared channel `key`. Subscribers of
 * the same key share one interval; it starts with the first subscriber and
 * stops with the last.
 */
export function useSharedPoll(
  key: string,
  tick: Tick,
  intervalMs = 5000,
): void {
  const tickRef = useRef(tick)
  // Sync in an effect (not during render) per the react-hooks/refs rule; the
  // first interval tick fires long after this effect has run.
  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  useEffect(() => {
    let ch = channels.get(key)
    if (!ch) {
      ch = {
        subs: new Set(),
        timer: setInterval(() => {
          const chan = channels.get(key)
          if (chan) void runTick(chan)
        }, intervalMs),
        inFlight: false,
      }
      channels.set(key, ch)
    }
    ch.subs.add(tickRef)

    return () => {
      const chan = channels.get(key)
      if (!chan) return
      chan.subs.delete(tickRef)
      if (chan.subs.size === 0) {
        clearInterval(chan.timer)
        channels.delete(key)
      }
    }
  }, [key, intervalMs])
}
