import { logger } from './logger.js'
import * as repo from './repo.js'
import { registry } from './registry.js'

/**
 * Per-channel serialization: jobs for the SAME channel run strictly in order
 * (send_code must never race the start job that created the login attempt;
 * two send_message jobs must not interleave through one MTProto session),
 * while jobs for DIFFERENT channels run in parallel. The map holds each
 * channel's queue tail; entries are pruned when the tail settles so the map
 * can't grow unboundedly.
 */
const channelTails = new Map<string, Promise<void>>()

function runSerialized(channelId: string, task: () => Promise<void>): Promise<void> {
  const prev = channelTails.get(channelId) ?? Promise.resolve()
  const next = prev.then(task, task)
  channelTails.set(channelId, next)
  void next.finally(() => {
    // Prune only if we are still the tail (nothing queued behind us).
    if (channelTails.get(channelId) === next) channelTails.delete(channelId)
  })
  return next
}

/** Claim and run a single job by id (triggered by NOTIFY). */
export async function processJob(jobId: string): Promise<void> {
  const job = await repo.claimJob(jobId)
  if (!job) return // already taken or not queued
  await runSerialized(job.channel_id, () => run(job))
}

/**
 * Drain any queued jobs (startup + safety net for missed notifications).
 *
 * Claims sequentially (claimNextQueued uses SKIP LOCKED so this is safe), but
 * executes through the same per-channel serializer as NOTIFY jobs: channels
 * drain in parallel with each other while staying ordered within themselves.
 * Previously this loop was fully sequential — one slow Telegram login blocked
 * every other channel's queued jobs.
 */
export async function drainQueue(): Promise<void> {
  const inFlight: Promise<void>[] = []
  for (;;) {
    const job = await repo.claimNextQueued()
    if (!job) break
    inFlight.push(runSerialized(job.channel_id, () => run(job)))
  }
  await Promise.allSettled(inFlight)
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
