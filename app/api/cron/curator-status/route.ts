import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { listCuratorsWithOverdueStatuses } from '@/lib/data/lead-cards'
import { isPastDailyDeadline } from '@/lib/lead-status'
import { sendPushToManager } from '@/lib/push'
import { runWithRequestContext } from '@/lib/request-context'
import { logServerError } from '@/lib/server-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Curator daily-status reminder sweep.
 *
 * Past the 10:00 MSK deadline, every active curator who still has leads
 * without today's status confirmation gets a web push — so the reminder works
 * even with the browser tab closed (the in-page StatusReminder only fires
 * while the workspace is open).
 *
 * Self-hosted: driven by pm2 via `scripts/cron-curator-status.mjs`
 * (app `omnidesk-cron-curator-status` in ecosystem.config.js) every 20
 * minutes. Running it often is safe: before the deadline it does nothing, and
 * after it the push uses a stable collapse tag, so repeats replace each other
 * instead of piling up.
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

  if (!isPastDailyDeadline()) {
    return NextResponse.json({ ok: true, result: { skipped: 'before_deadline' } })
  }

  try {
    const overdue = await listCuratorsWithOverdueStatuses()
    let notified = 0
    for (const c of overdue) {
      const body =
        c.pending === 1
          ? '1 лид ждёт подтверждения статуса.'
          : `${c.pending} лидов ждут подтверждения статуса.`
      const { sent } = await sendPushToManager(c.curatorId, {
        title: 'Omnidesk — обновите статусы',
        body: `${body} Рабочее место ограничено до обновления.`,
        url: '/curator',
        tag: 'omnidesk-curator-status',
      })
      if (sent > 0) notified += 1
    }
    return NextResponse.json({
      ok: true,
      result: { curatorsOverdue: overdue.length, notified },
    })
  } catch (error) {
    const errorId = logServerError('cron.curator-status', error)
    return NextResponse.json(
      { ok: false, error: 'server_error', errorId },
      { status: 500 },
    )
  }
}
