import { logger } from './logger.js'
import { startListener, pool } from './db.js'
import { startHttpServer } from './http.js'
import { processJob, drainQueue } from './jobs.js'
import { registry } from './registry.js'
import { runNoResponseSweep } from './autopilot.js'
import { captureException, initErrorReporter } from './error-reporter.js'
import { processDeployJob, drainDeployQueue } from './hosting/jobs.js'
import { sweepServerHealth } from './hosting/ops.js'

/** How often the autopilot 'no_response' scheduler scans for silent threads. */
const NO_RESPONSE_SWEEP_MS = 60_000

/** How often to health-check every managed hosting server. */
const HOSTING_HEALTH_SWEEP_MS = 120_000

let noResponseTimer: NodeJS.Timeout | null = null
let hostingHealthTimer: NodeJS.Timeout | null = null

async function main(): Promise<void> {
  logger.info('Omnidesk worker starting')

  // 0. Optional error reporting (Sentry). No-op unless SENTRY_DSN is set.
  await initErrorReporter()

  // 1. Internal HTTP API (QR + health)
  startHttpServer()

  // 2. React to new jobs instantly via Postgres NOTIFY
  await startListener('channel_jobs', (jobId) => {
    processJob(jobId).catch((err) =>
      logger.error({ err, jobId }, 'processJob failed'),
    )
  })

  // 3. Drain anything that was queued while we were down
  await drainQueue()

  // 3b. App Hosting ("Серверы"): consume deploy_jobs the same way — react to new
  //     jobs via NOTIFY, then drain anything queued while we were down.
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

  logger.info('Omnidesk worker ready')
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down worker')
  try {
    if (noResponseTimer) clearInterval(noResponseTimer)
    if (hostingHealthTimer) clearInterval(hostingHealthTimer)
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
