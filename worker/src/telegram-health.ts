import { Api, TelegramClient } from 'telegram'
import { returnBigInt } from 'telegram/Helpers.js'
import { logger } from './logger.js'
import { errMessage } from './telegram-errors.js'
import {
  TG_HEALTH_PING_MS,
  TG_HEALTH_PING_TIMEOUT_MS,
} from './telegram-config.js'

/** What the monitor needs from the owning session — nothing more. */
export interface TelegramHealthDeps {
  channelId: string
  getClient: () => TelegramClient | null
  /**
   * Called once a zombie connection is CONFIRMED (two consecutive failed
   * pings). The session tears down the dead transport and flips the channel to
   * 'error' so the normal auto-revival sweep reconnects with its own backoff.
   */
  onZombie: () => Promise<void>
}

/**
 * Zombie-connection detector for one Telegram session.
 *
 * A zombie connection (TCP alive, MTProto dead — typical after a proxy
 * hiccup) used to be discovered only when the next send failed; this monitor
 * probes with a lightweight Ping RPC on a fixed cadence so the session flips
 * to 'error' within ~2 ticks and auto-revival reconnects it.
 *
 * Ping is the cheapest possible MTProto RPC (no auth side-effects, exactly
 * what official clients send continuously). Dead connections often HANG
 * instead of erroring, so each probe races a timeout.
 */
export class TelegramHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  /** Consecutive failed pings; 2 in a row = declare the session dead. */
  private failures = 0
  /** Prevents overlapping ping probes when the connection hangs. */
  private probeActive = false

  constructor(private readonly deps: TelegramHealthDeps) {}

  /** (Re)start the periodic MTProto health ping. */
  start(): void {
    if (this.timer || TG_HEALTH_PING_MS <= 0) return
    this.failures = 0
    this.timer = setInterval(() => {
      void this.ping()
    }, TG_HEALTH_PING_MS)
    // Housekeeping only — never keep the event loop alive for it.
    this.timer.unref?.()
  }

  /** Stop the periodic MTProto health ping. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.failures = 0
    this.probeActive = false
  }

  /** One health probe. Two consecutive failures hand off to onZombie(). */
  private async ping(): Promise<void> {
    const client = this.deps.getClient()
    if (!client || this.probeActive) return
    this.probeActive = true
    try {
      await Promise.race([
        client.invoke(
          new Api.Ping({ pingId: returnBigInt(Date.now().toString()) }),
        ),
        new Promise((_, reject) => {
          const t = setTimeout(
            () => reject(new Error('health ping timeout')),
            TG_HEALTH_PING_TIMEOUT_MS,
          )
          t.unref?.()
        }),
      ])
      this.failures = 0
    } catch (err) {
      this.failures++
      logger.warn(
        {
          channelId: this.deps.channelId,
          failures: this.failures,
          err: errMessage(err),
        },
        'telegram health ping failed',
      )
      if (this.failures >= 2 && this.deps.getClient()) {
        // Zombie confirmed — the session owns the teardown.
        logger.error(
          { channelId: this.deps.channelId },
          'telegram session unresponsive — marking for revival',
        )
        await this.deps.onZombie()
      }
    } finally {
      this.probeActive = false
    }
  }
}
