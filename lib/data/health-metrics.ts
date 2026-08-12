import 'server-only'

/**
 * Deep health metrics for the admin settings "Здоровье системы" card.
 *
 * Complements lib/data/ai-health.ts (the co-pilot's channel/queue snapshot)
 * with the numbers an operator checks when things feel slow: brain latency
 * percentiles, outcome breakdown, webhook dead letters and queue pressure.
 * Aggregates only ADMIN-VISIBLE surfaces; every probe fails soft so one
 * missing table (fresh install mid-migration) never blanks the whole card.
 */
import { query } from '../db'

export interface BrainLatency {
  /** Calls in the window. */
  calls: number
  p50Ms: number | null
  p95Ms: number | null
  /** Share of calls that ended 'ok' (0..1); null when no calls. */
  okRate: number | null
  /** Non-ok outcomes with counts, worst first. */
  failures: Array<{ outcome: string; count: number }>
}

export interface DeadLetterHealth {
  /** Unresolved dead letters awaiting retry. */
  pending: number
  /** Letters that exhausted retries in the last 7 days. */
  exhausted7d: number
}

export interface QueuePressure {
  queued: number
  /** Age of the oldest waiting job in seconds (null = queue empty). */
  oldestQueuedSec: number | null
  errored24h: number
  done24h: number
}

export interface HealthMetrics {
  brain24h: BrainLatency
  deadLetters: DeadLetterHealth
  queue: QueuePressure
  /** Audit rows written in the last 24h — cheap "is the trail alive" signal. */
  auditWrites24h: number
  generatedAt: string
}

const EMPTY_BRAIN: BrainLatency = {
  calls: 0,
  p50Ms: null,
  p95Ms: null,
  okRate: null,
  failures: [],
}

async function brainLatency24h(): Promise<BrainLatency> {
  const [agg] = await query<{
    calls: string
    p50: string | null
    p95: string | null
    ok_calls: string
  }>(
    `SELECT
       COUNT(*) AS calls,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
       COUNT(*) FILTER (WHERE outcome = 'ok') AS ok_calls
     FROM ai_generation_metrics
     WHERE created_at >= now() - interval '24 hours'
       AND latency_ms IS NOT NULL`,
  )
  const calls = Number(agg?.calls ?? 0)
  if (calls === 0) return EMPTY_BRAIN

  const failures = await query<{ outcome: string; count: string }>(
    `SELECT outcome, COUNT(*) AS count
       FROM ai_generation_metrics
      WHERE created_at >= now() - interval '24 hours'
        AND outcome <> 'ok'
      GROUP BY outcome
      ORDER BY count DESC
      LIMIT 5`,
  )

  return {
    calls,
    p50Ms: agg.p50 == null ? null : Math.round(Number(agg.p50)),
    p95Ms: agg.p95 == null ? null : Math.round(Number(agg.p95)),
    okRate: Number(agg.ok_calls) / calls,
    failures: failures.map((f) => ({
      outcome: f.outcome,
      count: Number(f.count),
    })),
  }
}

async function deadLetterHealth(): Promise<DeadLetterHealth> {
  const [row] = await query<{ pending: string; exhausted: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending') AS pending,
       COUNT(*) FILTER (
         WHERE status = 'failed'
           AND created_at >= now() - interval '7 days'
       ) AS exhausted
     FROM webhook_dead_letter`,
  )
  return {
    pending: Number(row?.pending ?? 0),
    exhausted7d: Number(row?.exhausted ?? 0),
  }
}

async function queuePressure(): Promise<QueuePressure> {
  const [row] = await query<{
    queued: string
    oldest_sec: string | null
    errored: string
    done: string
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued') AS queued,
       EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE status = 'queued'))) AS oldest_sec,
       COUNT(*) FILTER (WHERE status = 'error' AND updated_at >= now() - interval '24 hours') AS errored,
       COUNT(*) FILTER (WHERE status = 'done' AND updated_at >= now() - interval '24 hours') AS done
     FROM channel_jobs`,
  )
  return {
    queued: Number(row?.queued ?? 0),
    oldestQueuedSec:
      row?.oldest_sec == null ? null : Math.round(Number(row.oldest_sec)),
    errored24h: Number(row?.errored ?? 0),
    done24h: Number(row?.done ?? 0),
  }
}

async function auditWrites24h(): Promise<number> {
  const [row] = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM audit_log
      WHERE created_at >= now() - interval '24 hours'`,
  )
  return Number(row?.n ?? 0)
}

/** Full metrics snapshot. Each probe fails soft to a safe zero-state. */
export async function getHealthMetrics(): Promise<HealthMetrics> {
  const [brain24h, deadLetters, queue, audit] = await Promise.all([
    brainLatency24h().catch(() => EMPTY_BRAIN),
    deadLetterHealth().catch(
      (): DeadLetterHealth => ({ pending: 0, exhausted7d: 0 }),
    ),
    queuePressure().catch(
      (): QueuePressure => ({
        queued: 0,
        oldestQueuedSec: null,
        errored24h: 0,
        done24h: 0,
      }),
    ),
    auditWrites24h().catch(() => 0),
  ])
  return {
    brain24h,
    deadLetters,
    queue,
    auditWrites24h: audit,
    generatedAt: new Date().toISOString(),
  }
}
