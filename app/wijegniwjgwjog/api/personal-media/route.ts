import { NextResponse, type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import { getChannelById } from '@/lib/data'
import { streamFromWorker } from '@/lib/worker-client'

/**
 * Живой стрим медиа личных Telegram-аккаунтов (god-панель): аватары
 * собеседников и вложения сообщений. Байты идут worker → panel → браузер,
 * НИЧЕГО не сохраняется на сервере (в отличие от message_media продавца).
 *
 * Гейт fail-closed: admin-сессия + god-разблокировка, иначе голый 404 —
 * та же форма ответа, что и у самой секретной страницы (AGENTS.md §4).
 */
export async function GET(req: NextRequest) {
  await requireAdmin()
  if (!(await isGodUnlocked())) {
    return new NextResponse(null, { status: 404 })
  }

  const { searchParams } = req.nextUrl
  const channelId = searchParams.get('channelId') ?? ''
  const peer = searchParams.get('peer') ?? ''
  const kind = searchParams.get('kind') ?? 'media' // 'avatar' | 'media'
  const messageId = searchParams.get('messageId') ?? ''

  if (!channelId || !peer) {
    return new NextResponse(null, { status: 404 })
  }

  // Скоуп: только личные аккаунты. Обычный telegram-канал через этот роут
  // недоступен — у продавца свой pipeline с персистом в message_media.
  const channel = await getChannelById(channelId)
  if (!channel || channel.type !== 'telegram_personal') {
    return new NextResponse(null, { status: 404 })
  }

  const params = new URLSearchParams({ channelId, peer })
  let path: string
  if (kind === 'avatar') {
    path = `/personal/avatar?${params.toString()}`
  } else {
    if (!messageId) return new NextResponse(null, { status: 404 })
    params.set('messageId', messageId)
    path = `/personal/media?${params.toString()}`
  }

  const workerRes = await streamFromWorker(path)
  if (!workerRes || !workerRes.ok || !workerRes.body) {
    return new NextResponse(null, { status: 404 })
  }

  const headers = new Headers()
  const passthrough = ['content-type', 'content-length', 'content-disposition']
  for (const name of passthrough) {
    const value = workerRes.headers.get(name)
    if (value) headers.set(name, value)
  }
  // Приватный кэш браузера: повторное открытие треда не перекачивает байты,
  // но на сервере и CDN ничего не оседает.
  headers.set(
    'cache-control',
    kind === 'avatar' ? 'private, max-age=3600' : 'private, max-age=86400',
  )

  return new NextResponse(workerRes.body, { status: 200, headers })
}
