import { query, one } from './db.js'

export interface JobRecord {
  id: string
  channel_id: string
  /** Null for system/admin-initiated jobs (e.g. God-panel kick). */
  manager_id: string | null
  action: string
  payload: Record<string, unknown>
  status: string
  /**
   * How many times this job has been claimed (1 on first run). Caps the
   * delayed-retry loop for FLOOD_WAIT sends — see scripts/109.
   */
  attempts: number
}

/** Atomically claim a single queued job (skip locked for concurrency safety). */
export async function claimJob(jobId: string): Promise<JobRecord | null> {
  const row = await one<JobRecord>(
    `UPDATE channel_jobs
       SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status = 'queued'
       AND (not_before IS NULL OR not_before <= now())
     RETURNING id, channel_id, manager_id, action, payload, status, attempts`,
    [jobId],
  )
  return row
}

/**
 * Claim any leftover queued jobs (startup + the periodic fallback drain).
 * Jobs parked for a delayed retry (not_before in the future) are invisible
 * until their time comes; the 45s fallback drain then picks them up — no
 * dedicated retry timer needed, and the schedule survives worker restarts
 * because it lives in the row, not in memory.
 */
export async function claimNextQueued(): Promise<JobRecord | null> {
  return one<JobRecord>(
    `UPDATE channel_jobs
       SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM channel_jobs
       WHERE status = 'queued'
         AND (not_before IS NULL OR not_before <= now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, channel_id, manager_id, action, payload, status, attempts`,
  )
}

/**
 * Park a job for a delayed retry: back to 'queued', invisible to claims until
 * `delaySeconds` from now. The wait reason is recorded in last_error so the
 * god-panel job view shows what the job is waiting out (typically FLOOD_WAIT).
 */
export async function rescheduleJob(
  jobId: string,
  delaySeconds: number,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE channel_jobs
       SET status = 'queued',
           not_before = now() + make_interval(secs => $2),
           last_error = $3,
           updated_at = now()
     WHERE id = $1`,
    [jobId, delaySeconds, reason],
  )
}

/**
 * Recover channel jobs orphaned in 'running' by a worker crash/redeploy.
 *
 * The per-channel serializer lives in worker memory, so after a restart NO
 * 'running' job is actually executing — but without this sweep they would sit
 * in 'running' forever: the panel keeps polling a result that never comes, and
 * (worse) listRevivableChannels / delivery recovery skip the channel because a
 * start/send job "is running", permanently blocking auto-revival for it.
 *
 * `olderThanMinutes` guards live claims: at startup 0 is safe (nothing has
 * been claimed by this process yet), while the periodic safety sweep uses a
 * threshold far above any legitimate job duration (jobs never run for tens of
 * minutes — history sync is backgrounded, not awaited inside the job).
 */
export async function recoverStuckChannelJobs(
  olderThanMinutes: number,
): Promise<number> {
  const rows = await query<{ id: string; action: string; payload: Record<string, unknown> }>(
    `UPDATE channel_jobs
       SET status = 'error',
           last_error = 'Worker restarted while the job was running',
           updated_at = now()
     WHERE status = 'running'
       AND updated_at < now() - make_interval(mins => $1)
     RETURNING id, action, payload`,
    [olderThanMinutes],
  )

  // A recovered SEND job carries an optimistic message row (inserted as
  // 'sent', confirmed later by the provider_message_id backfill) that will
  // otherwise look delivered forever — the job that would have resolved it is
  // dead. Flag still-unconfirmed ones failed with an honest reason so the
  // manager sees a retryable "!" instead of a silent maybe-never-sent.
  // (OFFLINE_SEND_REASON is NOT used on purpose: the auto-resend sweep must
  // not resend a message that MAY have reached Telegram just before the crash
  // — a human should decide, a duplicate to a client is worse than a retry
  // click.)
  const orphanedMessageIds = rows
    .filter((r) => ['send_message', 'send_voice', 'send_sticker', 'forward_message'].includes(r.action))
    .map((r) => r.payload?.messageId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (orphanedMessageIds.length > 0) {
    await query(
      `UPDATE messages
          SET status = 'failed',
              error_reason = 'Отправка прервана перезапуском воркера. Проверьте, дошло ли сообщение, и повторите при необходимости.'
        WHERE id = ANY($1)
          AND direction = 'out'
          AND status = 'sent'
          AND provider_message_id IS NULL`,
      [orphanedMessageIds],
    ).catch(() => {
      /* never let message flagging break job recovery itself */
    })
  }

  return rows.length
}

/**
 * Retention: purge finished jobs older than the window. Without this the
 * table grows forever — and voice-note jobs carry the FULL audio as base64 in
 * their payload (~0.4 MB each), so "forever" gets expensive fast. 7 days keeps
 * plenty of debugging history.
 */
export async function purgeFinishedChannelJobs(days = 7): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM channel_jobs
      WHERE status IN ('done', 'error')
        AND updated_at < now() - make_interval(days => $1)
      RETURNING id`,
    [days],
  )
  return rows.length
}

export async function finishJob(
  jobId: string,
  ok: boolean,
  result: Record<string, unknown> | null,
  error: string | null,
): Promise<void> {
  await query(
    `UPDATE channel_jobs
       SET status = $2, result = $3, last_error = $4, updated_at = now()
     WHERE id = $1`,
    [jobId, ok ? 'done' : 'error', result ? JSON.stringify(result) : null, error],
  )
}
