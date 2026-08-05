import { logger } from './logger.js'
import { startListener, pool } from './db.js'
import { startHttpServer } from './http.js'
import { processJob, drainQueue } from './jobs.js'
import * as repo from './repo.js'
import { registry } from './registry.js'
import { runNoResponseSweep } from './autopilot.js'
import { runRevivalSweep } from './revival.js'
import { captureException, initErrorReporter } from './error-reporter.js'
import { processDeployJob, drainDeployQueue } from './hosting/jobs.js'
import { sweepServerHealth } from './hosting/ops.js'
import { recoverStuckDeployments } from './hosting/repo.js'

/** How often the autopilot 'no_response' scheduler scans for silent threads. */
const NO_RESPONSE_SWEEP_MS = 60_000

/** How often to health-check every managed hosting server. */
const HOSTING_HEALTH_SWEEP_MS = 120_000

/**
 * How often the revival sweep looks for degraded Telegram sessions to
 * auto-reconnect. Each channel additionally has its own exponential backoff
 * inside the sweep, so a short scan period does not mean frequent retries.
 */
const REVIVAL_SWEEP_MS = 60_000

/**
 * Fallback queue drain: NOTIFY is best-effort — if the LISTEN connection dies
 * silently between keepalive pings, or the notification is emitted while the
 * listener is mid-reconnect, the job would otherwise sit 'queued' forever.
 * This periodic drain guarantees every queued job runs within this window even
 * with zero notifications delivered. Cheap when the queue is empty (one
 * indexed SELECT).
 */
const FALLBACK_DRAIN_MS = 45_000

/**
 * Periodic stuck-job recovery threshold. Far above any legitimate job
 * duration (login flows and sends complete in seconds; history sync is
 * backgrounded) so it can only ever catch orphans.
 */
const STUCK_JOB_SWEEP_MINUTES = 15

let noResponseTimer: NodeJS.Timeout | null = null
let hostingHealthTimer: NodeJS.Timeout | null = null
let revivalTimer: NodeJS.Timeout | null = null
let fallbackDrainTimer: NodeJS.Timeout | null = null

async function main(): Promise<void> {
  logger.info('Omnidesk worker starting')

  // 0. Optional error reporting (Sentry). No-op unless SENTRY_DSN is set.
  await initErrorReporter()

  // 1. Internal HTTP API (QR + health)
  startHttpServer()

  // 2. Recover channel jobs orphaned in 'running' by the previous process.
  //    MUST run before the listener/drain start claiming: at this point nothing
  //    has been claimed by this process, so every 'running' job is an orphan
  //    (threshold 0). Without this the panel waits forever on dead jobs and
  //    auto-revival stays blocked for the affected channels.
  const recoveredJobs = await repo.recoverStuckChannelJobs(0).catch((err) => {
    logger.error({ err }, 'recoverStuckChannelJobs failed')
    return 0
  })
  if (recoveredJobs > 0) {
    logger.warn({ recoveredJobs }, 'recovered stuck channel jobs on startup')
  }

  // React to new jobs instantly via Postgres NOTIFY
  await startListener('channel_jobs', (jobId) => {
    processJob(jobId).catch((err) =>
      logger.error({ err, jobId }, 'processJob failed'),
    )
  })

  // 3. Drain anything that was queued while we were down
  await drainQueue()

  // 3a. Safety net: periodically drain the queue and recover stale 'running'
  //     jobs even if every NOTIFY was lost (silently dead LISTEN connection,
  //     notification emitted mid-reconnect). See FALLBACK_DRAIN_MS.
  fallbackDrainTimer = setInterval(() => {
    drainQueue().catch((err) => logger.error({ err }, 'fallback drain failed'))
    repo
      .recoverStuckChannelJobs(STUCK_JOB_SWEEP_MINUTES)
      .then((n) => {
        if (n > 0) logger.warn({ recovered: n }, 'recovered stale running jobs')
      })
      .catch((err) => logger.error({ err }, 'stale job sweep failed'))
  }, FALLBACK_DRAIN_MS)
  fallbackDrainTimer.unref?.()

  // 3b. App Hosting ("Серверы"): consume deploy_jobs the same way — react to new
  //     jobs via NOTIFY, then drain anything queued while we were down.
  //     First recover deployments orphaned by a crash/redeploy so none stay
  //     stuck "running" forever.
  const recovered = await recoverStuckDeployments().catch((err) => {
    logger.error({ err }, 'recoverStuckDeployments failed')
    return 0
  })
  if (recovered > 0) {
    logger.warn({ recovered }, 'recovered stuck deployments on startup')
  }
  await startListener('deploy_jobs', (jobId) => {
    processDeployJob(jobId).catch((err) =>
      logger.error({ err, jobId }, 'processDeployJob failed'),
    )
  })
  await drainDeployQueue()

  // 3c. Periodically health-check every managed server (cpu/ram/disk/uptime).
  hostingHealthTimer = setInterval(() => {
    sweepServerHealth().catch((err) =>
      logger.error({ err }, 'hosting health sweep failed'),
    )
  }, HOSTING_HEALTH_SWEEP_MS)
  hostingHealthTimer.unref?.()

  // 4. Resume sessions that were live before the last restart
  await registry.restore()

  // 5. Autopilot 'no_response' scheduler: periodically scan for inbound threads
  //    a human hasn't answered and auto-reply per the manager's rules. Uses live
  //    sessions from the registry so it can only send on connected channels.
  noResponseTimer = setInterval(() => {
    runNoResponseSweep((channelId) => registry.get(channelId)).catch((err) =>
      logger.error({ err }, 'no-response sweep failed'),
    )
  }, NO_RESPONSE_SWEEP_MS)
  // Don't let the timer keep the event loop alive on shutdown.
  noResponseTimer.unref?.()

  // 6. Auto-revival: reconnect degraded Telegram sessions (offline/error with a
  //    saved session) automatically with per-channel exponential backoff — most
  //    outages heal here before the 5-minute manager banner would ever fire.
  revivalTimer = setInterval(() => {
    runRevivalSweep((channel) => registry.revive(channel)).catch((err) =>
      logger.error({ err }, 'revival sweep failed'),
    )
  }, REVIVAL_SWEEP_MS)
  revivalTimer.unref?.()

  logger.info('Omnidesk worker ready')
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down worker')
  try {
    if (noResponseTimer) clearInterval(noResponseTimer)
    if (hostingHealthTimer) clearInterval(hostingHealthTimer)
    if (revivalTimer) clearInterval(revivalTimer)
    if (fallbackDrainTimer) clearInterval(fallbackDrainTimer)
    await registry.shutdownAll()
    await pool.end()
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection')
  captureException(reason, { scope: 'process.unhandledRejection' })
})
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException')
  captureException(err, { scope: 'process.uncaughtException' })
})

main().catch((err) => {
  logger.error({ err }, 'Worker failed to start')
  captureException(err, { scope: 'main' })
  process.exit(1)
})
