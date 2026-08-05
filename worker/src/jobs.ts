import { logger } from './logger.js'
import * as repo from './repo.js'
import { registry } from './registry.js'
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

async function run(job: repo.JobRecord): Promise<void> {
  logger.info({ jobId: job.id, action: job.action }, 'Processing job')
  try {
    const result = await registry.handleJob(job)
    await repo.finishJob(job.id, true, result, null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ jobId: job.id, err: msg }, 'Job failed')
    await repo.finishJob(job.id, false, null, msg)
  }
}
