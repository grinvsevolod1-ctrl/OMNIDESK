import { logger } from '../logger.js'
import * as repo from './repo.js'
import { runDeploy } from './pipeline.js'
import { runHealthCheck, runLifecycle } from './ops.js'
import { runAiDeploy } from './agent.js'

/**
 * Deploy-job consumer, parallel to the channel-job processor. The worker LISTENs
 * on the 'deploy_jobs' NOTIFY channel and calls processDeployJob for each id;
 * drainDeployQueue is the startup safety-net for anything queued while it was
 * down. Each job is claimed atomically (skip-locked) so two workers never run
 * the same deploy.
 */

/** Claim and run a single deploy job by id (triggered by NOTIFY). */
export async function processDeployJob(jobId: string): Promise<void> {
  const job = await repo.claimJob(jobId)
  if (!job) return // already taken or not queued
  await run(job)
}

/** Drain any queued deploy jobs (startup + missed-notification safety net). */
export async function drainDeployQueue(): Promise<void> {
  for (;;) {
    const job = await repo.claimNextQueued()
    if (!job) break
    await run(job)
  }
}

async function run(job: repo.DeployJob): Promise<void> {
  logger.info({ jobId: job.id, action: job.action }, 'Processing deploy job')
  try {
    switch (job.action) {
      case 'deploy':
        await runDeploy(job)
        break
      case 'ai_deploy':
        await runAiDeploy(job)
        break
      case 'health_check':
        if (!job.server_id) throw new Error('health_check without server_id')
        await runHealthCheck(job.server_id)
        break
      case 'start':
      case 'stop':
      case 'restart':
      case 'remove':
      case 'rollback':
        if (!job.app_id) throw new Error(`${job.action} without app_id`)
        await runLifecycle(job.action, job.app_id)
        break
      default:
        throw new Error(`unknown deploy action: ${job.action as string}`)
    }
    await repo.finishJob(job.id, true, null, null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ jobId: job.id, err: msg }, 'Deploy job failed')
    await repo.finishJob(job.id, false, null, msg)
  }
}
