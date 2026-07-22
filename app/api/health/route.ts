import { checkDbConnection, getPoolStats } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Liveness/readiness probe for uptime monitors and PM2.
 *
 * Runs a cheap `SELECT 1` to confirm the database is actually reachable (not
 * just that the process is up) and reports live pool utilisation. Returns 200
 * when healthy and 503 when the DB is unreachable, so a monitor can alert or
 * PM2 can recycle the process. No auth: it leaks no sensitive data, only
 * connection health + pool counters.
 */
export async function GET(): Promise<Response> {
  const startedAt = Date.now()
  const db = await checkDbConnection()
  const body = {
    ok: db.ok,
    status: db.ok ? 'healthy' : 'degraded',
    db: { ok: db.ok, message: db.message },
    pool: db.ok ? getPoolStats() : null,
    uptimeSec: Math.round(process.uptime()),
    latencyMs: Date.now() - startedAt,
    at: new Date().toISOString(),
  }
  return Response.json(body, {
    status: db.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  })
}
