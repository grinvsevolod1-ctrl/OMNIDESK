/**
 * Node.js-only startup logic, split out of `instrumentation.ts`.
 *
 * This module is imported dynamically from `register()` ONLY when
 * `NEXT_RUNTIME === 'nodejs'`. Keeping the Node.js APIs (`process.on`,
 * `process.exit`, timers, the pg pool) out of `instrumentation.ts` means the
 * Edge compilation of the instrumentation hook never statically includes them,
 * which is what was breaking the build ("A Node.js API is used … not supported
 * in the Edge Runtime"). Everything here is guaranteed to run in Node.
 *
 * Responsibilities:
 *  - start the push dispatcher so inbound messages generate Web Push
 *    notifications regardless of whether a browser tab is open,
 *  - resume the client simulator engine if it was left enabled, and
 *  - install process-level safety nets + graceful shutdown.
 */
export async function registerNode(): Promise<void> {
  const { log } = await import('./lib/server-log')

  // Process-level safety net. The panel is a single long-lived Node process on
  // a VPS, so an unhandled rejection or thrown error in a background task (push
  // dispatch, realtime, simulator) must be logged rather than silently killing
  // the process. We log and keep running; genuinely fatal states are caught by
  // PM2 which restarts the process.
  process.on('unhandledRejection', (reason) => {
    log.error('process', 'unhandledRejection', { err: reason })
  })
  process.on('uncaughtException', (err) => {
    log.error('process', 'uncaughtException', { err })
  })

  // Graceful shutdown on PM2 reload / SIGTERM: stop the simulator loop and
  // close the DB pool so in-flight queries finish and no connection is leaked.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('process', 'shutting down', { signal })
    try {
      const { stopEngine, engineRunning } = await import(
        './lib/client-sim/engine'
      )
      if (engineRunning()) stopEngine()
    } catch {
      /* engine not loaded — nothing to stop */
    }
    try {
      const { getPool } = await import('./lib/db')
      await getPool().end()
    } catch {
      /* pool already closed */
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Periodic DB pool utilisation metric. Logged at info so it can be grepped
  // (scope "db-pool"); a persistently non-zero `waiting` means PGPOOL_MAX is
  // too low for the load. unref() so it never keeps the event loop alive.
  const { getPoolStats } = await import('./lib/db')
  const metricsTimer = setInterval(() => {
    try {
      log.info('db-pool', 'stats', getPoolStats())
    } catch {
      /* pool not initialised yet */
    }
  }, 60_000)
  metricsTimer.unref?.()

  const { startPushDispatcher } = await import('./lib/push-dispatcher')
  startPushDispatcher()

  // Resume the simulator if it was enabled before the last restart. Best-effort:
  // never let a boot-time DB hiccup crash server startup.
  try {
    const { getSettings } = await import('./lib/client-sim/store')
    const settings = await getSettings()
    if (settings.enabled) {
      const { startEngine } = await import('./lib/client-sim/engine')
      startEngine()
    }
  } catch (err) {
    log.warn('client-sim', 'resume-on-boot skipped', { err })
  }
}
