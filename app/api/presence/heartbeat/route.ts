import { getSession } from '@/lib/auth'
import { publishRealtime } from '@/lib/realtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Presence «на смене» для операторов. Открытая вкладка менеджера/куратора/
 * руководителя раз в ~25с шлёт сюда heartbeat; мы публикуем эфемерное
 * realtime-событие (actor: 'agent'), которое SSE-роут доставляет ТОЛЬКО
 * админской панели «Кто на смене». Ничего не пишется в БД — это, как typing и
 * visitor-presence, чисто транспортный сигнал, живущий по TTL на клиенте.
 *
 * Идентичность берётся из сессии (id + имя + роль) — клиент ничего не
 * подставляет, подделать нельзя. Админ/байер не отслеживаются как «смена».
 */
const OPERATOR_ROLES = new Set(['manager', 'curator', 'head'])

export async function POST(request: Request): Promise<Response> {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })

  if (!OPERATOR_ROLES.has(session.role)) {
    return Response.json({ ok: true, tracked: false })
  }

  // Пустое тело (sendBeacon при закрытии может не донести) → считаем «active».
  let state: 'active' | 'left' = 'active'
  try {
    const body = (await request.json()) as { state?: string } | null
    if (body?.state === 'left') state = 'left'
  } catch {
    /* нет тела — active */
  }

  await publishRealtime({
    type: 'presence',
    actor: 'agent',
    actorRole: session.role as 'manager' | 'curator' | 'head',
    presence: state === 'left' ? 'left' : 'open',
    id: session.sub,
    authorName: session.name,
  })

  return Response.json({ ok: true, tracked: true })
}
