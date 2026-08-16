import { logger } from './logger.js'
import * as repo from './repo.js'
import { registry } from './registry.js'
import { extractFloodWaitSeconds } from './telegram-errors.js'
// Per-channel serialization: jobs for the SAME channel run strictly in order
// (send_code must never race the start job that created the login attempt; two
// send_message jobs must not interleave through one MTProto session), while
// different channels run in parallel. Shared with the registry so revival and
// startup restore go through the SAME chain as queued jobs.
import { runSerialized } from './serialize.js'

/** Claim and run a single job by id (triggered by NOTIFY). */
export async function processJob(jobId: string): Promise<void> {
  const job = await repo.claimJob(jobId)
  if (!job) return // already taken or not queued
  await runSerialized(job.channel_id, () => run(job))
}

/**
 * Drain any queued jobs (startup + periodic safety net for missed
 * notifications — see the fallback interval in index.ts).
 *
 * Claims sequentially (claimNextQueued uses SKIP LOCKED so this is safe), but
 * executes through the same per-channel serializer as NOTIFY jobs: channels
 * drain in parallel with each other while staying ordered within themselves.
 * Previously this loop was fully sequential — one slow Telegram login blocked
 * every other channel's queued jobs.
 *
 * Re-entrancy guarded: the periodic fallback tick must not stack a second
 * claim loop on top of one that is still awaiting slow jobs.
 */
let drainInFlight = false

export async function drainQueue(): Promise<void> {
  if (drainInFlight) return
  drainInFlight = true
  try {
    const inFlight: Promise<void>[] = []
    for (;;) {
      const job = await repo.claimNextQueued()
      if (!job) break
      inFlight.push(runSerialized(job.channel_id, () => run(job)))
    }
    await Promise.allSettled(inFlight)
  } finally {
    drainInFlight = false
  }
}

/**
 * Delayed-retry policy for flood-limited SEND jobs.
 *
 * A FLOOD_WAIT_<N> answer is not a rejection — it's Telegram saying "this
 * exact request will succeed after N seconds". Failing the job terminally
 * (the old behavior) turned a 15-second wait into a dead "не доставлено"
 * message the manager had to notice and resend by hand. Instead, park the job
 * back in the queue with not_before = now + N (+ small buffer) and let the
 * fallback drain pick it up when the window has passed.
 *
 * Guardrails:
 * - only send-shaped actions: retrying a login/start job into a flood window
 *   risks SMS spam, and those failures surface in the UI anyway;
 * - only waits ≤ 10 min: longer floods mean the account is being throttled
 *   hard — the channel is already in `rate_limited` cooldown (see
 *   tripFloodCooldown) and the manager should see the failure, not wonder
 *   where the message is;
 * - max 3 claims per job: a channel that floods on every attempt must
 *   eventually fail loudly instead of cycling forever.
 */
const RETRIABLE_SEND_ACTIONS = new Set([
  'send_message',
  'send_voice',
  'send_sticker',
  'forward_message',
])
const MAX_FLOOD_RETRY_SECONDS = 600
const MAX_JOB_ATTEMPTS = 3
const RETRY_BUFFER_SECONDS = 2

async function run(job: repo.JobRecord): Promise<void> {
  logger.info(
    { jobId: job.id, action: job.action, attempt: job.attempts },
    'Processing job',
  )
  try {
    const result = await registry.handleJob(job)
    await repo.finishJob(job.id, true, result, null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)

    const floodSecs = extractFloodWaitSeconds(err)
    const canRetry =
      floodSecs !== null &&
      floodSecs <= MAX_FLOOD_RETRY_SECONDS &&
      RETRIABLE_SEND_ACTIONS.has(job.action) &&
      (job.attempts ?? 1) < MAX_JOB_ATTEMPTS

    if (canRetry) {
      const delay = floodSecs + RETRY_BUFFER_SECONDS
      logger.warn(
        { jobId: job.id, action: job.action, floodSecs, attempt: job.attempts },
        'Job hit FLOOD_WAIT — rescheduling instead of failing',
      )
      // The registry's send handler already flagged the optimistic message
      // 'failed' before rethrowing. Roll it back to pending-looking 'sent' so
      // the manager doesn't see a scary "!" for a message that is merely
      // waiting out a flood window and will still go out.
      const messageId =
        typeof job.payload?.messageId === 'string' ? job.payload.messageId : null
      if (messageId) {
        await repo.setMessageStatus(messageId, 'sent', null).catch(() => {})
      }
      await repo
        .rescheduleJob(job.id, delay, `FLOOD_WAIT_${floodSecs}: auto-retry scheduled`)
        .catch(async (rescheduleErr) => {
          // If parking fails we must not lose the job silently — fall back to
          // the terminal failure path (and restore the failed flag).
          logger.error({ jobId: job.id, err: rescheduleErr }, 'reschedule failed')
          if (messageId) {
            await repo
              .setMessageStatus(
                messageId,
                'failed',
                'Telegram временно ограничил отправку (флуд-контроль). Повторите позже.',
              )
              .catch(() => {})
          }
          await repo.finishJob(job.id, false, null, msg)
        })
      return
    }

    logger.error({ jobId: job.id, err: msg }, 'Job failed')
    await repo.finishJob(job.id, false, null, msg)
  }
}
