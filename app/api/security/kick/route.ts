import { jwtVerify } from 'jose'
import { NextResponse } from 'next/server'
import { bumpSessionVersion, getManagerById } from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'
import { rateLimit } from '@/lib/rate-limit'
import { getAuthSecret } from '@/lib/session'

export const runtime = 'nodejs'

/**
 * Кнопка «Разлогинить все» из push-уведомления «Вход с нового устройства».
 *
 * Аутентификация — НЕ cookie, а подписанный токен из самого push'а (24 ч,
 * purpose='kick'): service worker может нажать кнопку с устройства, чья
 * сессия давно протухла, — токен доказывает, что уведомление выдал наш
 * сервер этому сотруднику. Действие идемпотентно и строго ограничено:
 * продвинуть session_version (убивает все сессии и trusted-пропуски).
 * Хуже, чем «всех разлогинило», злоупотребить им нельзя.
 */
export async function POST(request: Request): Promise<Response> {
  const rl = await rateLimit('security-kick', 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ ok: false }, { status: 429 })
  }

  let token = ''
  try {
    const body = (await request.json()) as { token?: string }
    token = String(body.token ?? '')
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  if (!token) return NextResponse.json({ ok: false }, { status: 400 })

  let managerId: string
  try {
    const { payload } = await jwtVerify(token, getAuthSecret())
    if (payload.purpose !== 'kick' || typeof payload.sub !== 'string') {
      return NextResponse.json({ ok: false }, { status: 401 })
    }
    managerId = payload.sub
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  const manager = await getManagerById(managerId)
  if (!manager) return NextResponse.json({ ok: false }, { status: 404 })

  await bumpSessionVersion(managerId)
  await writeAudit({
    actorRole: manager.role === 'curator' ? 'curator' : 'manager',
    actorId: managerId,
    actorLabel: manager.name,
    action: 'auth.remote_kick',
    entityType: 'manager',
    entityId: managerId,
    details: { via: 'push' },
  })

  return NextResponse.json({ ok: true })
}
