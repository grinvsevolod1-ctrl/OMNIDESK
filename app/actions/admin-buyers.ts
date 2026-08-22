'use server'

/**
 * Админ: управление медиабайерами (role = 'buyer', миграция 145) — создание
 * учётки. Блокировка/сброс пароля/удаление — общие экшены аккаунтов из
 * app/actions/managers.ts. Источники байера назначаются на /admin/sources.
 */
import { revalidatePath } from 'next/cache'
import { hashPassword, requireAdmin } from '@/lib/auth'
import { generatePassword } from '@/lib/crypto'
import {
  createManager,
  getManagerByEmail,
  getManagerByIdentifier,
  sanitizeUsername,
} from '@/lib/data'
import { listBuyers, listTrafficSources } from '@/lib/data/traffic-sources'
import { writeAudit } from '@/lib/data/audit'
import type { ActionResult as BaseActionResult } from '@/lib/types'

export interface BuyerActionResult extends BaseActionResult {
  password?: string
  username?: string
}

/** Admin: байеры + их источники (для таблицы /admin/buyers). */
export async function listBuyersAdminAction() {
  await requireAdmin()
  const [buyers, sources] = await Promise.all([
    listBuyers(),
    listTrafficSources(),
  ])
  return {
    buyers: buyers.map((b) => ({
      ...b,
      sources: sources
        .filter((s) => s.buyerId === b.id)
        .map((s) => ({ id: s.id, name: s.name, isActive: s.isActive })),
    })),
  }
}

/** Admin: создать учётку медиабайера. */
export async function createBuyerAction(
  formData: FormData,
): Promise<BuyerActionResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const usernameRaw = String(formData.get('username') ?? '').trim()
  let password = String(formData.get('password') ?? '')

  if (!name || !email) return { ok: false, message: 'Укажите имя и email.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'Введите корректный email.' }
  }
  const username = usernameRaw ? sanitizeUsername(usernameRaw) : ''
  if (usernameRaw && (!username || username.length < 3)) {
    return {
      ok: false,
      message: 'Логин: минимум 3 символа (a-z, 0-9, точка, дефис, _).',
    }
  }
  if (!password) {
    password = generatePassword(16)
  } else if (password.length < 8) {
    return { ok: false, message: 'Пароль должен быть не короче 8 символов.' }
  }

  if (await getManagerByEmail(email)) {
    return { ok: false, message: 'Аккаунт с таким email уже существует.' }
  }
  if (username && (await getManagerByIdentifier(username))) {
    return { ok: false, message: 'Этот логин уже занят.' }
  }

  const passwordHash = await hashPassword(password)
  const created = await createManager({
    name,
    email,
    passwordHash,
    username: username || undefined,
    role: 'buyer',
  })
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'buyer.create',
    entityType: 'manager',
    entityId: created.id,
    details: { name, email },
  })
  revalidatePath('/admin/buyers')
  return {
    ok: true,
    message: `Медиабайер ${name} создан.`,
    password,
    username: created.username ?? undefined,
  }
}
