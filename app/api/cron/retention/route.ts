import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { logServerError } from '@/lib/server-log'
import { runWithRequestContext } from '@/lib/request-context'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Nightly data-retention sweep for append-only tables that nothing else
 * bounds. Complements (does not duplicate) existing cleanup:
 *   - ai_logs            — ring-buffer cap on write (lib/data/ai-log.ts)
 *   - webhook_dead_letter— pruned by the retry-dead-letters cron
 *   - login_bans         — pruned by the retry-dead-letters cron
 *   - media blobs        — orphan sweep in the retry-dead-letters cron
 *   - channel_jobs       — purged at worker boot; ALSO swept here because a
 *                          healthy PM2 worker can run for weeks without a
 *                          restart, and voice-note payloads are ~0.4 MB each
 *
 * Windows are deliberately conservative — this is bounding growth, not
 * aggressive space reclamation:
 *   - ai_generation_metrics: 365 days (cost analytics stay useful for a year)
 *   - admin_audit_log:       180 days
 *   - hosting_deploy_logs:    30 days (only useful while debugging a deploy)
 *   - channel_jobs:            7 days (finished jobs; mirrors worker boot purge)
 *
 * Batched with LIMIT per table per tick so a first run against years of
 * backlog can't hold long locks; the nightly cadence drains any backlog in a
 * few days. Self-hosted: driven by pm2 via scripts/cron-retention.mjs.
 */
export async function GET(request: Request): Promise<Response> {
  return runWithRequestContext(request, () => handle(request))
}

const BATCH = 5_000

interface Sweep {
  table: string
  days: number
  /** Extra WHERE conditions beyond the age cutoff. */
  extra?: string
  /** Column holding the row's age (defaults to created_at). */
  ageColumn?: string
}

const SWEEPS: Sweep[] = [
  { table: 'ai_generation_metrics', days: 365 },
  { table: 'admin_audit_log', days: 180 },
  { table: 'audit_log', days: 180 },
  { table: 'hosting_deploy_logs', days: 30 },
  {
    table: 'channel_jobs',
    days: 7,
    ageColumn: 'updated_at',
    extra: `AND status IN ('done', 'error')`,
  },
]

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json(
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
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const purged: Record<string, number> = {}
  for (const sweep of SWEEPS) {
    const age = sweep.ageColumn ?? 'created_at'
    try {
      // Identifiers are from the hardcoded SWEEPS list above, never from
      // request input; the age window is parameterized.
      const rows = await query<{ id: string }>(
        `DELETE FROM ${sweep.table}
          WHERE id IN (
            SELECT id FROM ${sweep.table}
             WHERE ${age} < now() - make_interval(days => $1)
               ${sweep.extra ?? ''}
             LIMIT ${BATCH}
          )
          RETURNING id`,
        [sweep.days],
      )
      purged[sweep.table] = rows.length
    } catch (err) {
      // A missing table (migration not applied on this install) or transient
      // error must not abort the remaining sweeps.
      logServerError(`cron.retention.${sweep.table}`, err)
      purged[sweep.table] = -1
    }
  }

  return NextResponse.json({ ok: true, purged })
}
