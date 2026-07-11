import { NextResponse } from 'next/server'
import { syncAllAdAccounts } from '@/lib/ads-yandex'

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
  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const result = await syncAllAdAccounts()
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Не удалось синхронизировать кабинеты.'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
