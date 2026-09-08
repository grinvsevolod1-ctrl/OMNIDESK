import { logger } from './logger.js'

/**
 * Session warm-up sweep ("прогрев сессий").
 *
 * Idle Telegram accounts that just sit connected are dead weight and — worse —
 * an account that never does anything looks unnatural. This sweep keeps every
 * LIVE session (already connected in the registry; it NEVER logs anyone in)
 * gently active: it marks accounts online/offline on a human-like, jittered
 * per-account schedule and occasionally does a light dialog read.
 *
 * Safety model (matches the "безопасная имитация" the owner asked for):
 *  - Only channels with a live session object are touched (registry-driven);
 *    a logged-out or offline account is never woken up here.
 *  - NO messages are ever sent. The only RPCs are account.updateStatus (what
 *    an official client sends while open) and an occasional getDialogs read.
 *  - Per-account next-run time with jitter so accounts never act in lockstep —
 *    a synchronized burst across 50 accounts is the classic bot fingerprint.
 *  - Each account flips online/offline over time ("выходят/заходят") instead of
 *    being pinned online forever.
 *  - State lives in worker memory: a restart just re-staggers everyone, which
 *    is exactly what we want.
 */

interface WarmState {
  /** Earliest wall-clock time this account may act again. */
  nextRunAt: number
  /** Current presence we last set — flipped each run to come and go. */
  online: boolean
}

/** Per-account cadence: act roughly every 3–8 minutes, jittered. */
const MIN_INTERVAL_MS = 3 * 60_000
const MAX_INTERVAL_MS = 8 * 60_000
/** Probability a given tick also pulls a tiny dialog page (light read). */
const READ_DIALOGS_CHANCE = 0.25

const state = new Map<string, WarmState>()

/**
 * Re-entrancy guard: a pass touches many accounts, each through an MTProto RPC,
 * so a single pass can outlast the sweep interval. Overlapping passes would
 * double-schedule the same account; one pass at a time.
 */
let sweepInFlight = false

function nextInterval(): number {
  return (
    MIN_INTERVAL_MS +
    Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS))
  )
}

/**
 * One warm-up pass. `liveChannelIds` returns the currently connected sessions;
 * `warm` performs the actual presence update on one of them (the registry
 * adapter wires this to `session.warmupTick`). The sweep only decides WHO acts
 * and WHEN.
 */
export async function runWarmupSweep(
  liveChannelIds: () => string[],
  warm: (
    channelId: string,
    opts: { online: boolean; readDialogs: boolean },
  ) => Promise<void>,
): Promise<void> {
  if (sweepInFlight) return
  sweepInFlight = true
  try {
    const ids = liveChannelIds()
    const live = new Set(ids)

    // Forget accounts whose session is no longer live.
    for (const id of state.keys()) {
      if (!live.has(id)) state.delete(id)
    }

    const now = Date.now()
    for (const id of ids) {
      let s = state.get(id)
      if (!s) {
        // First sighting: stagger the initial run across the whole window so a
        // fresh worker doesn't warm every account in the same tick.
        state.set(id, {
          nextRunAt: now + Math.floor(Math.random() * MAX_INTERVAL_MS),
          online: false,
        })
        continue
      }
      if (now < s.nextRunAt) continue

      // Flip presence so the account naturally comes online and goes away.
      s.online = !s.online
      s.nextRunAt = now + nextInterval()
      try {
        await warm(id, {
          online: s.online,
          readDialogs: Math.random() < READ_DIALOGS_CHANCE,
        })
      } catch (err) {
        logger.warn({ channelId: id, err }, 'warmup tick failed (non-fatal)')
      }
    }
  } finally {
    sweepInFlight = false
  }
}
