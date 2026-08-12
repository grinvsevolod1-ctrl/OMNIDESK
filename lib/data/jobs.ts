/**
 * Channel job queue: enqueue actions and read dispatch state.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
import type { ChannelJob, JobAction, JobStatus } from '../types'

/* ------------------------------- Jobs ------------------------------- */

interface JobRow {
  id: string
  channel_id: string
  manager_id: string
  action: JobAction
  payload: Record<string, unknown>
  status: JobStatus
  result: Record<string, unknown> | null
  last_error: string | null
  created_at: string | Date
  updated_at: string | Date
}

function toJob(r: JobRow): ChannelJob {
  return {
    id: r.id,
    channelId: r.channel_id,
    managerId: r.manager_id,
    action: r.action,
    payload: r.payload ?? {},
    status: r.status,
    result: r.result ?? null,
    lastError: r.last_error ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

/**
 * Enqueue a command for the worker. The INSERT trigger fires pg_notify so the
 * worker picks it up instantly; if the worker is down it drains the queue on
 * next start.
 *
 * Idempotent for sends: at most one LIVE (queued/running) send_message job
 * may exist per payload.messageId (unique index, migration 126). A duplicate
 * enqueue — double-click, action retry, HTTP retry after timeout — returns
 * the already-live job instead of double-delivering to the client.
 */
export async function enqueueJob(input: {
  channelId: string
  /** Null for system/admin-initiated jobs (env-backed super-admin has no row). */
  managerId: string | null
  action: JobAction
  payload?: Record<string, unknown>
}): Promise<ChannelJob> {
  const id = randomUUID()
  const rows = await query<JobRow>(
    `INSERT INTO channel_jobs (id, channel_id, manager_id, action, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ((payload->>'messageId'))
       WHERE action = 'send_message'
         AND status IN ('queued', 'running')
         AND (payload->>'messageId') IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      id,
      input.channelId,
      input.managerId,
      input.action,
      JSON.stringify(input.payload ?? {}),
    ],
  )
  if (rows[0]) return toJob(rows[0])
  // Conflict path: a live send job for this message already exists — reuse it.
  const messageId =
    typeof input.payload?.messageId === 'string' ? input.payload.messageId : null
  const existing = messageId
    ? await query<JobRow>(
        `SELECT * FROM channel_jobs
          WHERE action = 'send_message'
            AND status IN ('queued', 'running')
            AND payload->>'messageId' = $1
          LIMIT 1`,
        [messageId],
      )
    : []
  if (existing[0]) return toJob(existing[0])
  // Extremely unlikely: the live job finished between INSERT and SELECT.
  // Retry once without losing the message.
  const retry = await query<JobRow>(
    `INSERT INTO channel_jobs (id, channel_id, manager_id, action, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      randomUUID(),
      input.channelId,
      input.managerId,
      input.action,
      JSON.stringify(input.payload ?? {}),
    ],
  )
  return toJob(retry[0])
}

