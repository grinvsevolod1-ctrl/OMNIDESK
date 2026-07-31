/**
 * Pluggable error reporter for the Next.js panel process.
 *
 * Sentry is OPTIONAL and fully gated on the `SENTRY_DSN` environment variable,
 * so the app stays self-hostable with zero external dependencies by default:
 *  - no SENTRY_DSN  -> every function here is a no-op (errors still hit the
 *    structured logs via lib/server-log);
 *  - SENTRY_DSN set -> exceptions are additionally forwarded to Sentry.
 *
 * We use @sentry/node (not @sentry/nextjs) and initialise it from the Node
 * instrumentation hook. This captures all server + route-handler exceptions
 * without a build-time webpack/Turbopack plugin. Client-side errors are not
 * sent to Sentry by design (kept simple for a self-hosted ops setup).
 */

type SentryModule = typeof import('@sentry/node')

let sentry: SentryModule | null = null
let initialised = false

/**
 * Initialise Sentry once, if configured. Safe to call from instrumentation on
 * every boot; a missing DSN or a missing package is handled gracefully.
 */
export async function initErrorReporter(): Promise<void> {
  if (initialised) return
  initialised = true

  const dsn = process.env.SENTRY_DSN
  if (!dsn) return // Not configured — stay a no-op.

  try {
    const mod = await import('@sentry/node')
    mod.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      release: process.env.SENTRY_RELEASE,
      // Keep tracing off by default; this is an error reporter, not an APM.
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    })
    sentry = mod
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        level: 'info',
        scope: 'error-reporter',
        msg: 'sentry_initialised',
      }),
    )
  } catch (err) {
    // Package not installed or init failed — degrade to logs-only.
    console.warn(
      '[error-reporter] Sentry configured but could not initialise:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Forward an exception to Sentry if enabled. Never throws. `errorId` correlates
 * the Sentry event with the structured log line emitted by logServerError.
 */
export function captureException(
  error: unknown,
  context?: { scope?: string; errorId?: string; extra?: Record<string, unknown> },
): void {
  if (!sentry) return
  try {
    sentry.captureException(error, {
      tags: {
        ...(context?.scope ? { scope: context.scope } : {}),
        ...(context?.errorId ? { errorId: context.errorId } : {}),
      },
      extra: context?.extra,
    })
  } catch {
    // Reporting must never break the request path.
  }
}

/** True when Sentry is active — handy for health/metrics output. */
export function isErrorReporterEnabled(): boolean {
  return sentry !== null
}

// Register a globalThis hook so the edge-safe structured logger
// (lib/server-log) can forward errors here without importing @sentry/node.
;(
  globalThis as unknown as {
    __captureException?: (
      e: unknown,
      c?: { scope?: string; errorId?: string },
    ) => void
  }
).__captureException = captureException
