import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { processDeadLetterQueue } from '@/lib/webhook-replay'
import { logServerError } from '@/lib/server-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Replay of the inbound webhook dead-letter queue.
 *
 * When a VK/MAX webhook fails to ingest an inbound message it is parked in
 * `webhook_dead_letter` (see migration 075). This endpoint drains the due rows,
 * re-resolving the live channel + agent and replaying each message through the
 * normal ingest + autopilot path with exponential backoff.
 *
 * Self-hosted: driven on a schedule by pm2/crontab via
 * `scripts/cron-retry-dead-letters.mjs` (app `omnidesk-cron-retry-dead-letters`
 * in ecosystem.config.js). Protected by the same CRON_SECRET bearer check the
 * other cron endpoints use. A short interval (e.g. every minute) is fine — the
 * backoff lives in the row's next_retry_at, not the schedule.
 */
export async function GET(request: Request): Promise<Response> {
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

  try {
    const result = await processDeadLetterQueue(50)
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const errorId = logServerError('cron.retry-dead-letters', error)
    return NextResponse.json(
      { ok: false, error: 'server_error', errorId },
      { status: 500 },
    )
  }
}
