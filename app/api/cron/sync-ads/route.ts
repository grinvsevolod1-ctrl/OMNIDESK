import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { syncAllAdAccounts } from '@/lib/ads-yandex'
import { logServerError } from '@/lib/server-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Периодическая синхронизация рекламных кабинетов с Яндекс.Директом.
 * Вызывается Vercel Cron (см. vercel.json). Защищено секретом CRON_SECRET:
 * Vercel автоматически шлёт заголовок `Authorization: Bearer <CRON_SECRET>`.
 * Ручные корректировки god-страницы при этом сохраняются — новые данные
 * приплюсовываются поверх зафиксированного baseline.
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
    const result = await syncAllAdAccounts()
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const errorId = logServerError('cron.sync-ads', error)
    return NextResponse.json(
      { ok: false, error: 'server_error', errorId },
      { status: 500 },
    )
  }
}
