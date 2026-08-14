'use server'

import { getSession, startSession } from '@/lib/auth'
import {
  bumpSessionVersion,
  getManagerAuthState,
  getManagerById,
} from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'

export interface SessionsActionResult {
  ok: boolean
  message: string
}

/**
 * «Разлогинить все устройства» из вкладки «Сессии» настроек менеджера или
 * куратора. Продвигает session_version (мгновенно отзывая каждый выданный
 * JWT), после чего перевыпускает cookie ТЕКУЩЕЙ сессии со свежей версией —
 * инициатор остаётся в системе, все остальные устройства получают редирект
 * на /login при следующем запросе (проверка в proxy.ts + page-гейтах).
 */
export async function logoutOtherDevicesAction(): Promise<SessionsActionResult> {
  const session = await getSession()
  if (!session || (session.role !== 'manager' && session.role !== 'curator')) {
    return { ok: false, message: 'Нет доступа' }
  }

  const manager = await getManagerById(session.sub)
  if (!manager) return { ok: false, message: 'Аккаунт не найден' }

  await bumpSessionVersion(manager.id)

  // Перевыпускаем собственную cookie со свежей версией — тот же паттерн, что
  // при самостоятельной смене пароля (см. account-profile.ts).
  const fresh = await getManagerAuthState(manager.id)
  await startSession({
    sub: manager.id,
    role: session.role,
    email: manager.email,
    name: manager.name,
    sv: fresh?.sessionVersion ?? 0,
  })

  await writeAudit({
    actorRole: session.role,
    actorId: manager.id,
    actorLabel: manager.name,
    action: 'auth.logout_other_devices',
    entityType: 'manager',
    entityId: manager.id,
  })

  return { ok: true, message: 'Все остальные устройства разлогинены' }
}
