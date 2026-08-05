import { logger } from './logger.js'
import * as repo from './repo.js'

/**
 * Automatic session revival ("авто-реанимация").
 *
 * A Telegram account that drops to offline/error (proxy blip, DC hiccup,
 * transient network failure) used to stay dead until a human noticed the
 * banner and reconnected it by hand. This sweep restarts such sessions
 * automatically — BEFORE anyone gets alerted (the manager banner only fires
 * after 5 minutes of degradation, so a successful revival is invisible).
 *
 * Safety model:
 *  - Only channels with a SAVED session string are revived (repo query):
 *    reconnecting those needs zero interaction. Channels without one would
 *    start a phone-code login and spam the owner with SMS — never touched.
 *  - `logged_out` / `rate_limited` are excluded: the first needs a human,
 *    the second must wait out Telegram's flood window.
 *  - Per-channel EXPONENTIAL BACKOFF (1m → 2m → 4m → … capped at 30m) so a
 *    genuinely broken account (dead proxy, revoked session that still looks
 *    like 'error') is not hammered — hammering MTProto logins risks a ban.
 *  - Backoff state is in worker memory: a worker restart resets it, which is
 *    fine — the restart itself re-attempts via registry.restore().
 */

interface BackoffState {
  /** Consecutive failed revival attempts. */
  attempts: number
  /** Earliest wall-clock time the next attempt is allowed. */
  nextAttemptAt: number
}

const BASE_DELAY_MS = 60_000
const MAX_DELAY_MS = 30 * 60_000

const backoff = new Map<string, BackoffState>()

/** Compute the wait after `attempts` consecutive failures (exponential, capped). */
function delayFor(attempts: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempts)
}

/**
 * One revival pass. `startChannel` performs the actual reconnect and resolves
 * with the resulting session status (the registry adapter wires this to
 * `ensure(channel).start()`); the sweep only decides WHO to revive and WHEN.
 */
export async function runRevivalSweep(
  startChannel: (
    channel: repo.ChannelRecord,
  ) => Promise<{ sessionStatus: repo.SessionStatus }>,
): Promise<void> {
  const channels = await repo.listRevivableChannels()
  const now = Date.now()

  // Sessions that recovered by other means (admin reconnect, worker restart)
  // must not keep stale backoff state around.
  const revivable = new Set(channels.map((c) => c.id))
  for (const id of backoff.keys()) {
    if (!revivable.has(id)) backoff.delete(id)
  }

  for (const channel of channels) {
    const state = backoff.get(channel.id)
    if (state && now < state.nextAttemptAt) continue

    const attempts = state?.attempts ?? 0
    logger.info(
      { channelId: channel.id, attempt: attempts + 1 },
      'Revival: attempting automatic reconnect',
    )
    try {
      const res = await startChannel(channel)
      if (res.sessionStatus === 'online') {
        backoff.delete(channel.id)
        logger.info({ channelId: channel.id }, 'Revival: session back online')
      } else {
        // Went to code_pending/error/etc — a human is needed or it failed.
        // Back off; code_pending can't happen here (saved session required),
        // but any non-online outcome counts as a failed revival.
        backoff.set(channel.id, {
          attempts: attempts + 1,
          nextAttemptAt: now + delayFor(attempts + 1),
        })
        logger.warn(
          { channelId: channel.id, outcome: res.sessionStatus },
          'Revival: reconnect did not reach online, backing off',
        )
      }
    } catch (err) {
      backoff.set(channel.id, {
        attempts: attempts + 1,
        nextAttemptAt: now + delayFor(attempts + 1),
      })
      logger.warn(
        { channelId: channel.id, err },
        'Revival: reconnect attempt failed, backing off',
      )
    }
  }
}
