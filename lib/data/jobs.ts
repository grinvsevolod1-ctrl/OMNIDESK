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
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      id,
      input.channelId,
      input.managerId,
      input.action,
      JSON.stringify(input.payload ?? {}),
    ],
  )
  return toJob(rows[0])
}

