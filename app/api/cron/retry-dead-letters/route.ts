import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { processDeadLetterQueue } from '@/lib/webhook-replay'
import { pruneLoginBans } from '@/lib/data'
import { cleanupOrphanedMediaBlobs } from '@/lib/data/media-archive'
import { pruneDeadLetters } from '@/lib/data/webhook-dead-letter'
import { logServerError } from '@/lib/server-log'
import { runWithRequestContext } from '@/lib/request-context'

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
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await processDeadLetterQueue(50)
    // Piggyback cheap housekeeping on the same minute tick: drop expired login
    // bans so the table doesn't accumulate dead rows.
    const prunedBans = await pruneLoginBans()
    // …и подчистить осиротевшие media_blobs (байты без единой ссылки из
    // messages/message_edits/lead_attachments). Не критично для реплея —
    // ошибка чистки не должна ронять весь тик.
    const prunedBlobs = await cleanupOrphanedMediaBlobs().catch((err) => {
      logServerError('cron.cleanup-media-blobs', err)
      return 0
    })
    // …и отработанные dead-letters: resolved старше 7 дней, failed старше
    // 30 дней (pending не трогаются). Без этого таблица растёт вечно.
    const prunedDeadLetters = await pruneDeadLetters().catch((err) => {
      logServerError('cron.prune-dead-letters', err)
      return 0
    })
    return NextResponse.json({
      ok: true,
      result,
      prunedBans,
      prunedBlobs,
      prunedDeadLetters,
    })
  } catch (error) {
    const errorId = logServerError('cron.retry-dead-letters', error)
    return NextResponse.json(
      { ok: false, error: 'server_error', errorId },
      { status: 500 },
    )
  }
}
