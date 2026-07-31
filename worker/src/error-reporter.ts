import { logger } from './logger.js'

/**
 * Optional Sentry error reporting for the worker process.
 *
 * Fully gated on SENTRY_DSN so the worker stays dependency-free by default:
 *  - no DSN  -> every function is a no-op (errors still hit the pino logs);
 *  - DSN set -> exceptions are additionally forwarded to Sentry.
 *
 * Kept intentionally tiny and mirrors the panel's lib/error-reporter so both
 * processes report to the same project when configured.
 */

type SentryModule = typeof import('@sentry/node')

let sentry: SentryModule | null = null

export async function initErrorReporter(): Promise<void> {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  try {
    const mod = await import('@sentry/node')
    mod.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      // Tag events so panel vs worker is distinguishable in Sentry.
      initialScope: { tags: { service: 'omnidesk-worker' } },
    })
    sentry = mod
    logger.info('Sentry error reporting initialised')
  } catch (err) {
    logger.warn(
      { err },
      'SENTRY_DSN set but Sentry could not initialise; logs-only',
    )
  }
}

/** Forward an exception to Sentry if enabled. Never throws. */
export function captureException(
  error: unknown,
  context?: { scope?: string },
): void {
  if (!sentry) return
  try {
    sentry.captureException(
      error,
      context?.scope ? { tags: { scope: context.scope } } : undefined,
    )
  } catch {
    /* reporting must never break the worker */
  }
}
