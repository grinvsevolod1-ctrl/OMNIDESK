import { logger } from './logger.js'
import * as repo from './repo.js'
import { extractFloodWaitSeconds } from './telegram-errors.js'
import {
  TG_SEND_JITTER_MS,
  TG_SEND_MIN_INTERVAL_MS,
} from './telegram-config.js'

/**
 * Per-account send pacing + FLOOD_WAIT cooldown for one Telegram session.
 * Extracted from the TelegramSession monolith — the session owns ONE instance
 * and hands `throttle()` / `tripFloodCooldown()` to the messaging modules.
 *
 * Pacing: a minimum, slightly random spacing between sends so the account
 * never bursts at machine speed. Atomic via a promise chain: queued sends and
 * direct callers (autopilot replies bypass the job queue) can hit this
 * concurrently, and a read-sleep-write version would let both read the same
 * lastSentAt and pass together — a two-message burst, exactly what the
 * throttle exists to prevent. Chaining serializes the gap computation itself.
 *
 * Flood cooldown: when Telegram answers FLOOD_WAIT with a meaningful duration,
 * the WHOLE channel gates sends locally (every attempt during an active window
 * extends the ban server-side) and the panel shows `rate_limited` until the
 * window passes, when the status flips back to online automatically.
 */
export class TelegramSendThrottle {
  private readonly channelId: string
  /** Live-client probe: cooldown recovery must not overwrite stop/logout. */
  private readonly isClientAlive: () => boolean
  /** Timestamp of the last outgoing send, for per-account rate limiting. */
  private lastSentAt = 0
  /** Deadline (epoch ms) until which ALL sends are refused. */
  private floodCooldownUntil = 0
  private tail: Promise<void> = Promise.resolve()

  constructor(channelId: string, isClientAlive: () => boolean) {
    this.channelId = channelId
    this.isClientAlive = isClientAlive
  }

  /** Serialize and pace one send. Throws while a flood cooldown is active. */
  throttle(): Promise<void> {
    const next = this.tail.then(async () => {
      // Flood gate first: while a FLOOD_WAIT window is active every further
      // attempt would extend the ban, so refuse outright. The error text keeps
      // the FLOOD_WAIT_<secs> shape so telegramSendFailureReason renders the
      // proper human explanation on the failed message row.
      const coolMs = this.floodCooldownUntil - Date.now()
      if (coolMs > 0) {
        throw new Error(`FLOOD_WAIT_${Math.ceil(coolMs / 1000)} (local cooldown)`)
      }
      const since = Date.now() - this.lastSentAt
      const minGap =
        TG_SEND_MIN_INTERVAL_MS + Math.floor(Math.random() * TG_SEND_JITTER_MS)
      if (since < minGap) {
        await new Promise((r) => setTimeout(r, minGap - since))
      }
      this.lastSentAt = Date.now()
    })
    // Keep the chain alive even if a caller's continuation throws later.
    this.tail = next.catch(() => {})
    return next
  }

  /**
   * Inspect a send failure and, when Telegram answered FLOOD_WAIT with a
   * meaningful duration (>= 30s), put the whole channel into cooldown. Short
   * waits are left to the normal per-send pacing.
   */
  tripFloodCooldown(err: unknown): void {
    const secs = extractFloodWaitSeconds(err)
    if (!secs || secs < 30) return
    this.floodCooldownUntil = Date.now() + secs * 1000
    logger.warn(
      { channelId: this.channelId, floodWaitSecs: secs },
      'channel entering flood cooldown',
    )
    void repo.setSession(this.channelId, 'rate_limited').catch(() => {})
    const timer = setTimeout(() => {
      // Only restore if nothing else changed the state meanwhile and the
      // client is still alive (a stop/logout must not be overwritten).
      if (this.isClientAlive() && Date.now() >= this.floodCooldownUntil) {
        void repo.setSession(this.channelId, 'online').catch(() => {})
      }
    }, secs * 1000)
    timer.unref?.()
  }
}
