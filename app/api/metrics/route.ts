import { timingSafeEqual } from 'node:crypto'
import { getPoolStats } from '@/lib/db'
import { getDeadLetterStats } from '@/lib/data'
import { isErrorReporterEnabled } from '@/lib/error-reporter'
import { logServerError } from '@/lib/server-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Operational metrics for scrapers / dashboards.
 *
 * Unlike /api/health (public, liveness only), this exposes internal counters
 * (DB pool pressure, dead-letter queue depth, memory) that shouldn't be public,
 * so it is gated behind the same CRON_SECRET bearer token as the cron
 * endpoints. Point a monitor at it with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return Response.json(
      { ok: false, error: 'service_not_configured' },
      { status: 503 },
    )
  }
  const auth = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`
  const authorized =
    auth.length === expected.length &&
    timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
  if (!authorized) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  try {
    const [deadLetter] = await Promise.all([getDeadLetterStats()])
    const mem = process.memoryUsage()
    return Response.json(
      {
        ok: true,
        at: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        pid: process.pid,
        pool: getPoolStats(),
        deadLetter,
        memory: {
          rssMb: Math.round(mem.rss / 1024 / 1024),
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        },
        errorReporter: isErrorReporterEnabled() ? 'sentry' : 'logs-only',
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    const errorId = logServerError('api.metrics', error)
    return Response.json(
      { ok: false, error: 'server_error', errorId },
      { status: 500 },
    )
  }
}
