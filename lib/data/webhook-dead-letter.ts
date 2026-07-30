/**
 * Durable dead-letter queue for inbound webhook messages (see migration 075).
 *
 * When a VK/MAX webhook fails to ingest an inbound message (e.g. a transient DB
 * error), instead of dropping it we persist the normalized inbound here and a
 * background loop replays it with exponential backoff. This module owns the
 * table access; the replay/dispatch logic lives in lib/webhook-replay.ts.
 */
import { query } from '../db'

export type DeadLetterChannelType = 'vk' | 'max'

export interface DeadLetterRecord {
  id: string
  channelType: DeadLetterChannelType
  channelId: string
  contactHandle: string
  providerMessageId: string | null
  /** Normalized recordXInbound arg object (minus pool/fallbackManagerId). */
  payload: Record<string, unknown>
  status: 'pending' | 'resolved' | 'failed'
  attempts: number
  maxAttempts: number
  lastError: string | null
  nextRetryAt: string
  createdAt: string
}

interface Row {
  id: string
  channel_type: DeadLetterChannelType
  channel_id: string
  contact_handle: string
  provider_message_id: string | null
  payload: Record<string, unknown>
  status: 'pending' | 'resolved' | 'failed'
  attempts: number
  max_attempts: number
  last_error: string | null
  next_retry_at: string | Date
  created_at: string | Date
}

function toRecord(r: Row): DeadLetterRecord {
  return {
    id: r.id,
    channelType: r.channel_type,
    channelId: r.channel_id,
    contactHandle: r.contact_handle,
    providerMessageId: r.provider_message_id,
    payload: r.payload ?? {},
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    nextRetryAt: new Date(r.next_retry_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/**
 * Record a failed inbound so it can be replayed later. Idempotent for a given
 * (channel, providerMessageId) while still pending — a re-delivered webhook that
 * fails again won't stack duplicate rows (ON CONFLICT bumps the error instead).
 */
export async function recordWebhookDeadLetter(input: {
  channelType: DeadLetterChannelType
  channelId: string
  contactHandle: string
  providerMessageId?: string | null
  payload: Record<string, unknown>
  error: string
}): Promise<void> {
  await query(
    `INSERT INTO webhook_dead_letter
       (channel_type, channel_id, contact_handle, provider_message_id, payload, last_error)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (channel_id, provider_message_id)
       WHERE status = 'pending' AND provider_message_id IS NOT NULL
     DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = now()`,
    [
      input.channelType,
      input.channelId,
      input.contactHandle,
      input.providerMessageId ?? null,
      JSON.stringify(input.payload),
      input.error.slice(0, 2000),
    ],
  )
}

/**
 * Atomically claim up to `limit` due rows for processing. Uses
 * FOR UPDATE SKIP LOCKED so multiple workers never grab the same row, and
 * pushes next_retry_at forward so a long replay can't be double-claimed by the
 * next tick. The actual result (resolved/failed) is written afterwards.
 */
export async function claimDueDeadLetters(
  limit = 20,
): Promise<DeadLetterRecord[]> {
  const rows = await query<Row>(
    `WITH due AS (
       SELECT id FROM webhook_dead_letter
        WHERE status = 'pending' AND next_retry_at <= now()
        ORDER BY next_retry_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE webhook_dead_letter d
        SET attempts = d.attempts + 1,
            -- Park it briefly so a slow replay isn't re-claimed mid-flight;
            -- markRetryFailed overwrites this with the real backoff on failure.
            next_retry_at = now() + interval '5 minutes',
            updated_at = now()
       FROM due
      WHERE d.id = due.id
      RETURNING d.*`,
    [limit],
  )
  return rows.map(toRecord)
}

/** Mark a dead-letter successfully replayed. */
export async function markDeadLetterResolved(id: string): Promise<void> {
  await query(
    `UPDATE webhook_dead_letter
        SET status = 'resolved', resolved_at = now(), updated_at = now(),
            last_error = NULL
      WHERE id = $1`,
    [id],
  )
}

/**
 * Record a failed replay attempt. Applies exponential backoff
 * (2^attempts minutes, capped at 6h) and gives up — marking the row 'failed' —
 * once attempts reach max_attempts, so a permanently broken message stops
 * consuming retries but stays visible for inspection.
 */
export async function markRetryFailed(
  id: string,
  attempts: number,
  maxAttempts: number,
  error: string,
): Promise<void> {
  if (attempts >= maxAttempts) {
    await query(
      `UPDATE webhook_dead_letter
          SET status = 'failed', last_error = $2, updated_at = now()
        WHERE id = $1`,
      [id, error.slice(0, 2000)],
    )
    return
  }
  // 2^attempts minutes, capped at 360 (6h).
  const backoffMinutes = Math.min(2 ** attempts, 360)
  await query(
    `UPDATE webhook_dead_letter
        SET last_error = $2,
            next_retry_at = now() + ($3 || ' minutes')::interval,
            updated_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 2000), String(backoffMinutes)],
  )
}

/** Counts for the god panel / health metrics. */
export async function getDeadLetterStats(): Promise<{
  pending: number
  failed: number
}> {
  const rows = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n
       FROM webhook_dead_letter
      WHERE status IN ('pending', 'failed')
      GROUP BY status`,
  )
  const stats = { pending: 0, failed: 0 }
  for (const r of rows) {
    if (r.status === 'pending') stats.pending = Number(r.n)
    else if (r.status === 'failed') stats.failed = Number(r.n)
  }
  return stats
}
