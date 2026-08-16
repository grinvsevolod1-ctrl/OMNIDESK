'use client'

/**
 * Lightweight client-error monitoring: forwards uncaught browser errors and
 * unhandled promise rejections to /api/client-errors, where they land in the
 * server (PM2) logs with a [client-error] marker. That turns "у менеджера
 * что-то не работает" from a verbal report into a grep-able stack trace —
 * without a third-party service or SDK weight.
 *
 * Safety rails: per-session cap, duplicate suppression, fire-and-forget
 * keepalive sends (never blocks or breaks the page), and the reporter itself
 * is wrapped so it can never throw.
 */

import { useEffect } from 'react'

const MAX_REPORTS_PER_SESSION = 10

export function ErrorReporter() {
  useEffect(() => {
    let sent = 0
    const seen = new Set<string>()

    const report = (payload: {
      message: string
      stack?: string
      source?: string
    }) => {
      try {
        if (sent >= MAX_REPORTS_PER_SESSION) return
        const key = payload.message.slice(0, 200)
        if (seen.has(key)) return
        seen.add(key)
        sent++
        const body = JSON.stringify({
          ...payload,
          url: window.location.pathname,
          ua: navigator.userAgent.slice(0, 160),
          at: new Date().toISOString(),
        })
        // sendBeacon survives page unloads; fetch keepalive is the fallback.
        if (!navigator.sendBeacon?.('/api/client-errors', body)) {
          void fetch('/api/client-errors', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            keepalive: true,
          }).catch(() => {})
        }
      } catch {
        /* the reporter must never itself become an error source */
      }
    }

    const onError = (e: ErrorEvent) => {
      // Ignore cross-origin "Script error." noise — no actionable info.
      if (e.message === 'Script error.' && !e.filename) return
      report({
        message: String(e.message ?? 'unknown error').slice(0, 500),
        stack: typeof e.error?.stack === 'string' ? e.error.stack.slice(0, 2000) : undefined,
        source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
      })
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason
      report({
        message: `unhandledrejection: ${String(
          reason instanceof Error ? reason.message : reason,
        ).slice(0, 500)}`,
        stack:
          reason instanceof Error && typeof reason.stack === 'string'
            ? reason.stack.slice(0, 2000)
            : undefined,
      })
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return null
}
