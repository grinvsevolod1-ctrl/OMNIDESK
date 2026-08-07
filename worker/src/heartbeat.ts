/**
 * Worker liveness heartbeat (scripts/118).
 *
 * Upserts the singleton worker_heartbeat row every minute so the admin panel
 * can tell "the worker is alive" from "PM2 process died and Telegram went
 * silent". Tolerates the migration not being applied yet: a failed beat is
 * logged at debug level and retried on the next tick — the worker itself
 * never depends on this table.
 */
import os from 'node:os'
import { query } from './db.js'
import { logger } from './logger.js'

export const HEARTBEAT_INTERVAL_MS = 60_000

const startedAt = new Date()

/** Write one heartbeat tick. Never throws. */
export async function beat(): Promise<void> {
  try {
    await query(
      `INSERT INTO worker_heartbeat (id, beaten_at, started_at, pid, hostname)
       VALUES (true, now(), $1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET beaten_at = now(),
             started_at = EXCLUDED.started_at,
             pid = EXCLUDED.pid,
             hostname = EXCLUDED.hostname`,
      [startedAt.toISOString(), process.pid, os.hostname()],
    )
  } catch (err) {
    // Missing table (migration not applied) or transient DB hiccup — the
    // heartbeat must never take the worker down with it.
    logger.debug({ err }, 'heartbeat write failed')
  }
}

/** Start the heartbeat loop; returns the timer so shutdown can clear it. */
export function startHeartbeat(): NodeJS.Timeout {
  void beat() // first beat immediately, not a minute later
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  return timer
}
