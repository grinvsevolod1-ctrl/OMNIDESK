import { query } from '../db'

/**
 * Worker liveness from the heartbeat table (scripts/118).
 *
 * The PM2 worker upserts one row a minute; if the row is stale the worker
 * process is down (or wedged) and Telegram/VK/MAX channels are silently dead.
 * Tolerates the migration not being applied yet: reports "unknown" instead of
 * crashing the dashboard.
 */

/** Consider the worker down after this many minutes without a beat. */
const STALE_AFTER_MINUTES = 3

export interface WorkerHealth {
  status: 'alive' | 'down' | 'unknown'
  /** Minutes since the last beat (rounded), null when unknown. */
  staleMinutes: number | null
  /** When the current worker process started, null when unknown. */
  startedAt: string | null
}

export async function getWorkerHealth(): Promise<WorkerHealth> {
  try {
    const rows = await query<{
      beaten_at: string
      started_at: string
      stale_min: string | number
    }>(
      `SELECT beaten_at, started_at,
              EXTRACT(EPOCH FROM (now() - beaten_at)) / 60 AS stale_min
         FROM worker_heartbeat
        WHERE id = true`,
    )
    if (rows.length === 0) {
      // Table exists but the worker has never beaten — treat as down.
      return { status: 'down', staleMinutes: null, startedAt: null }
    }
    const staleMinutes = Math.max(0, Math.round(Number(rows[0].stale_min)))
    return {
      status: staleMinutes >= STALE_AFTER_MINUTES ? 'down' : 'alive',
      staleMinutes,
      startedAt: rows[0].started_at,
    }
  } catch {
    // Migration 118 not applied yet — don't take the dashboard down.
    return { status: 'unknown', staleMinutes: null, startedAt: null }
  }
}
