import { NextResponse } from 'next/server'
import { syncAllAdAccounts } from '@/lib/ads-yandex'
import { requireCronAuth } from '@/lib/cron-auth'
import { runInstrumentedCron } from '@/lib/data/cron-runs'
import { logServerError } from '@/lib/server-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Периодическая синхронизация рекламных кабинетов с Яндекс.Директом.
 * На self-hosted VPS вызывается по расписанию из pm2/crontab через
 * `scripts/cron-sync-ads.mjs` (см. ecosystem.config.js, app
 * `omnidesk-cron-sync-ads`). Защищено секретом CRON_SECRET: триггер шлёт
 * заголовок `Authorization: Bearer <CRON_SECRET>`.
 * Ручные корректировки god-страницы при этом сохраняются — новые данные
 * приплюсовываются поверх зафиксированного baseline.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireCronAuth(request)
  if (denied) return denied

  try {
    const result = await runInstrumentedCron('sync-ads', () =>
      syncAllAdAccounts(),
    )
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const errorId = logServerError('cron.sync-ads', error)
    return NextResponse.json(
      { ok: false, error: 'server_error', errorId },
      { status: 500 },
    )
  }
}
