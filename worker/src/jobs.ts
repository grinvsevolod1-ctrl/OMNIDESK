import { logger } from './logger.js'
import * as repo from './repo.js'
import { registry } from './registry.js'

/** Claim and run a single job by id (triggered by NOTIFY). */
export async function processJob(jobId: string): Promise<void> {
  const job = await repo.claimJob(jobId)
  if (!job) return // already taken or not queued
  await run(job)
}

/** Drain any queued jobs (startup + safety net for missed notifications). */
export async function drainQueue(): Promise<void> {
  for (;;) {
    const job = await repo.claimNextQueued()
    if (!job) break
    await run(job)
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
