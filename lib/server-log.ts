import { randomUUID } from 'node:crypto'

/**
 * Structured, level-based logging for the Next.js panel process.
 *
 * Mirrors the worker's pino-style logger (worker/src/logger.ts) but with zero
 * dependencies: it prints a single JSON line per event so `pm2 logs` output can
 * be grepped/parsed. Level order is debug < info < warn < error; the threshold
 * is controlled by LOG_LEVEL (default 'info', so debug is suppressed in prod).
 *
 * Existing call sites keep using logServerError / serverErrorResponse — those
 * now route through the same structured emitter for consistency.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function threshold(): number {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase()
  return LEVEL_WEIGHT[raw as LogLevel] ?? LEVEL_WEIGHT.info
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return err
}

function emit(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (LEVEL_WEIGHT[level] < threshold()) return
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    msg: message,
  }
  // Attach the current request id when running inside a request context. Read
  // via a globalThis hook set by lib/request-context so this module stays free
  // of node:async_hooks and safe to bundle for the Edge runtime.
  const reqId = (
    globalThis as unknown as { __getRequestId?: () => string | undefined }
  ).__getRequestId?.()
  if (reqId) line.requestId = reqId
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      line[k] = k === 'err' || k === 'error' ? serializeError(v) : v
    }
  }
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  try {
    out(JSON.stringify(line))
  } catch {
    // Circular meta or similar — fall back to a plain line.
    out(`[${level}] ${scope}: ${message}`)
  }
}

export const log = {
  debug: (scope: string, message: string, meta?: Record<string, unknown>) =>
    emit('debug', scope, message, meta),
  info: (scope: string, message: string, meta?: Record<string, unknown>) =>
    emit('info', scope, message, meta),
  warn: (scope: string, message: string, meta?: Record<string, unknown>) =>
    emit('warn', scope, message, meta),
  error: (scope: string, message: string, meta?: Record<string, unknown>) =>
    emit('error', scope, message, meta),
}

/**
 * Log an unexpected server error with a generated correlation id. Returns the
 * id so it can be surfaced to the client (without leaking the error details)
 * and later grepped out of the logs.
 */
export function logServerError(scope: string, error: unknown): string {
  const errorId = randomUUID()
  emit('error', scope, 'server_error', { errorId, err: error })
  // Best-effort forward to the optional error reporter (Sentry). Read via a
  // globalThis hook set by lib/error-reporter's init so this module stays
  // edge-safe and free of the @sentry/node import.
  ;(
    globalThis as unknown as {
      __captureException?: (
        e: unknown,
        c?: { scope?: string; errorId?: string },
      ) => void
    }
  ).__captureException?.(error, { scope, errorId })
  return errorId
}

export function serverErrorResponse(scope: string, error: unknown): Response {
  const errorId = logServerError(scope, error)
  return Response.json(
    { ok: false, error: 'server_error', errorId },
    { status: 500 },
  )
}
