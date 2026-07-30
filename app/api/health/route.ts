import { timingSafeEqual } from 'node:crypto'
import { checkDbConnection, getPoolStats } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Constant-time bearer check against CRON_SECRET (same secret the cron uses). */
function isTrusted(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const provided = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch — guard first so a wrong-length
  // token can't be distinguished by a thrown error.
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Liveness/readiness probe for uptime monitors and PM2.
 *
 * Runs a cheap `SELECT 1` to confirm the database is actually reachable (not
 * just that the process is up). Returns 200 when healthy and 503 when the DB is
 * unreachable, so a monitor can alert or PM2 can recycle the process.
 *
 * Internal telemetry (pool utilisation, uptime, DB latency/message) is only
 * returned to callers presenting the CRON_SECRET bearer token — an anonymous
 * probe from the public internet gets a minimal ok/status so we don't leak
 * connection-pool internals or the DB error text to strangers.
 */
export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now()
  const db = await checkDbConnection()
  const trusted = isTrusted(request)

  const body = trusted
    ? {
        ok: db.ok,
        status: db.ok ? 'healthy' : 'degraded',
        db: { ok: db.ok, message: db.message },
        pool: db.ok ? getPoolStats() : null,
        uptimeSec: Math.round(process.uptime()),
        latencyMs: Date.now() - startedAt,
        at: new Date().toISOString(),
      }
    : {
        // Minimal public payload: enough for a dumb uptime monitor to read
        // 200 vs 503, nothing sensitive.
        ok: db.ok,
        status: db.ok ? 'healthy' : 'degraded',
      }

  return Response.json(body, {
    status: db.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  })
}
