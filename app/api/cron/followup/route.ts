import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runInstrumentedCron } from '@/lib/data/cron-runs'
import { runFollowupSweep } from '@/lib/followup/runtime'
import { logServerError } from '@/lib/server-log'
import { runWithRequestContext } from '@/lib/request-context'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Follow-up autopilot sweep.
 *
 * Finds REAL clients (never simulated) who went silent on an AI-led dialog and,
 * if follow-up is enabled in the co-pilot settings, sends one gentle nudge each
 * — across every allowed channel — respecting quiet hours and the per-streak
 * touch cap. Does nothing until an admin turns follow-up on through chat.
 *
 * Self-hosted: driven on a schedule by pm2/crontab via
 * `scripts/cron-followup.mjs` (app `omnidesk-cron-followup` in
 * ecosystem.config.js). Protected by the same CRON_SECRET bearer check the
 * other cron endpoints use. Running it often is safe — the delay, quiet-hours
 * and dedup guards live in the data layer, not the schedule.
 */
export async function GET(request: Request): Promise<Response> {
  return runWithRequestContext(request, () => handle(request))
}

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
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    )
  }

  try {
    const result = await runInstrumentedCron('followup', () =>
      runFollowupSweep(25),
    )
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const errorId = logServerError('cron.followup', error)
    return NextResponse.json(
      { ok: false, error: 'server_error', errorId },
      { status: 500 },
    )
  }
}
