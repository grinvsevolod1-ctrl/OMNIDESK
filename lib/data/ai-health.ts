import 'server-only'

/**
 * System-health snapshot for the admin co-pilot: answers "почему бот молчит?"
 * with facts instead of guesses. Aggregates only ADMIN-VISIBLE surfaces:
 * channel/session statuses, the worker's job queue, recent AI errors and the
 * AI Gateway credit balance. Nothing here reaches beyond the regular admin
 * panel's data.
 */
import { query } from '../db'
import { getGatewayBalance } from '../ai/gateway-balance'
import { listAiLogs } from './ai-log'

export interface ChannelHealth {
  type: string
  name: string
  status: string
  sessionStatus: string | null
}

export interface QueueHealth {
  /** Jobs waiting to be picked up by the worker right now. */
  queued: number
  /** Age of the oldest waiting job, in seconds (null when queue is empty). */
  oldestQueuedSec: number | null
  /** Jobs that errored in the last 24h. */
  errored24h: number
  /**
   * Best-effort worker liveness: false when jobs sit unclaimed for over
   * 5 minutes — the strongest available signal that the worker is down.
   */
  workerLikelyAlive: boolean
}

export interface SystemHealth {
  channels: ChannelHealth[]
  queue: QueueHealth
  /** Error-level AI log entries in the last 24h, with the freshest messages. */
  aiErrors24h: number
  recentErrors: Array<{ event: string; message: string; at: string }>
  gateway: {
    ok: boolean
    /** Remaining credit in USD, null when unreadable. */
    balanceUsd: number | null
    totalUsedUsd: number | null
    note?: string
  }
}

const STALE_QUEUE_SEC = 300

/** Collect the full health snapshot. Individual probes fail soft. */
export async function getSystemHealth(): Promise<SystemHealth> {
  const [channels, queue, errors, balance] = await Promise.all([
    channelHealth().catch(() => [] as ChannelHealth[]),
    queueHealth().catch(
      (): QueueHealth => ({
        queued: 0,
        oldestQueuedSec: null,
        errored24h: 0,
        workerLikelyAlive: true,
      }),
    ),
    recentAiErrors().catch(() => ({ count: 0, recent: [] as SystemHealth['recentErrors'] })),
    getGatewayBalance().catch(() => null),
  ])

  return {
    channels,
    queue,
    aiErrors24h: errors.count,
    recentErrors: errors.recent,
    gateway: {
      ok: balance?.ok ?? false,
      balanceUsd: balance?.balance ?? null,
      totalUsedUsd: balance?.totalUsed ?? null,
      note: balance?.ok
        ? undefined
        : (balance?.message ?? 'Баланс временно недоступен'),
    },
  }
}

async function channelHealth(): Promise<ChannelHealth[]> {
  const rows = await query<{
    type: string
    name: string
    status: string
    session_status: string | null
  }>(
    `SELECT type, name, status, session_status
       FROM channels
      ORDER BY type, created_at DESC
      LIMIT 30`,
  )
  return rows.map((r) => ({
    type: r.type,
    name: r.name,
    status: r.status,
    sessionStatus: r.session_status,
  }))
}

async function queueHealth(): Promise<QueueHealth> {
  const [row] = await query<{
    queued: string | number
    oldest_sec: string | number | null
    errored: string | number
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued') AS queued,
       EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE status = 'queued'))) AS oldest_sec,
       COUNT(*) FILTER (WHERE status = 'error' AND updated_at >= now() - interval '24 hours') AS errored
     FROM channel_jobs`,
  )
  const queued = Number(row.queued)
  const oldest = row.oldest_sec == null ? null : Math.round(Number(row.oldest_sec))
  return {
    queued,
    oldestQueuedSec: oldest,
    errored24h: Number(row.errored),
    workerLikelyAlive: oldest == null || oldest < STALE_QUEUE_SEC,
  }
}

async function recentAiErrors(): Promise<{
  count: number
  recent: SystemHealth['recentErrors']
}> {
  const rows = await listAiLogs({ scope: 'ai', limit: 100 })
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  const errors = rows.filter(
    (r) => r.level === 'error' && new Date(r.createdAt).getTime() >= dayAgo,
  )
  return {
    count: errors.length,
    recent: errors.slice(0, 5).map((r) => ({
      event: r.event,
      message: r.message,
      at: r.createdAt,
    })),
  }
}
