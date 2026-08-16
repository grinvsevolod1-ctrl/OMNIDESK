import { NextResponse } from 'next/server'
import { runDueSchedules } from '@/lib/admin-console/schedule-runner'
import { requireCronAuth } from '@/lib/cron-auth'
import { runInstrumentedCron } from '@/lib/data/cron-runs'
import { logServerError } from '@/lib/server-log'
import { runWithRequestContext } from '@/lib/request-context'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * OS shell scheduled-commands sweep. Runs due console_schedules through the
 * shell copilot core. Same CRON_SECRET bearer contract as the other cron
 * endpoints; safe to call every few minutes — claiming is atomic
 * (FOR UPDATE SKIP LOCKED), so overlapping ticks never double-run.
 */
export async function GET(request: Request): Promise<Response> {
  return runWithRequestContext(request, () => handle(request))
}

async function handle(request: Request): Promise<Response> {
  const denied = requireCronAuth(request)
  if (denied) return denied

  try {
    const result = await runInstrumentedCron('console-schedules', () =>
      runDueSchedules(5),
    )
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const errorId = logServerError('cron.console-schedules', error)
    return NextResponse.json(
      { ok: false, error: 'server_error', errorId },
      { status: 500 },
    )
  }
}
