'use server'

import { revalidatePath } from 'next/cache'
import { invalidateAnalytics } from '@/lib/analytics-cache'
import { hashPassword, requireAdmin } from '@/lib/auth'
import { generatePassword } from '@/lib/crypto'
import {
  createCurator,
  createManager,
  deleteManager,
  getManagerByEmail,
  getManagerById,
  getManagerByIdentifier,
  sanitizeUsername,
  updateCuratorCity,
  updateManagerPassword,
  updateManagerStatus,
} from '@/lib/data'
import { isAdminIdentity } from '@/lib/data/shared'

export interface ActionResult {
  ok: boolean
  message: string
  password?: string
  username?: string
}

// Server-issued passwords use the CSPRNG-backed generator in lib/crypto so they
// cannot be predicted (Math.random() is not cryptographically secure).
function genPassword(): string {
  return generatePassword(16)
}

export async function createManagerAction(
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const usernameRaw = String(formData.get('username') ?? '').trim()
  let password = String(formData.get('password') ?? '')

  if (!name || !email) {
    return { ok: false, message: 'Укажите имя и email.' }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'Введите корректный email.' }
  }
  // A custom login is optional; when provided it must be a valid handle.
  const username = usernameRaw ? sanitizeUsername(usernameRaw) : ''
  if (usernameRaw && (!username || username.length < 3)) {
    return {
      ok: false,
      message: 'Логин: минимум 3 символа (a-z, 0-9, точка, дефис, _).',
    }
  }
  if (!password) {
    password = genPassword()
  } else if (password.length < 8) {
    return { ok: false, message: 'Пароль должен быть не короче 8 символов.' }
  }

  const existing = await getManagerByEmail(email)
  if (existing) {
    return { ok: false, message: 'Аккаунт с таким email уже существует.' }
  }
  if (username) {
    const takenBy = await getManagerByIdentifier(username)
    if (takenBy) {
      return { ok: false, message: 'Этот логин уже занят.' }
    }
  }

  const passwordHash = await hashPassword(password)
  const created = await createManager({
    name,
    email,
    passwordHash,
    username: username || undefined,
    role: 'manager',
  })
  // A new manager appears in getManagerPerformance rollups; drop the analytics
  // cache so the dashboard lists them without waiting out the TTL.
  invalidateAnalytics()
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return {
    ok: true,
    message: `Менеджер ${name} создан.`,
    password,
    username: created.username ?? undefined,
  }
}

/**
 * Create a curator account. Same credentials flow as managers, plus a required
 * city the curator is responsible for. Only the admin may call this.
 */
export async function createCuratorAction(
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const usernameRaw = String(formData.get('username') ?? '').trim()
  const city = String(formData.get('city') ?? '').trim()
  let password = String(formData.get('password') ?? '')

  if (!name || !email) {
    return { ok: false, message: 'Укажите имя и email.' }
  }
  if (!city) {
    return { ok: false, message: 'Укажите город, за который отвечает куратор.' }
  }
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
    password = genPassword()
  } else if (password.length < 8) {
    return { ok: false, message: 'Пароль должен быть не короче 8 символов.' }
  }

  const existing = await getManagerByEmail(email)
  if (existing) {
    return { ok: false, message: 'Аккаунт с таким email уже существует.' }
  }
  if (username) {
    const takenBy = await getManagerByIdentifier(username)
    if (takenBy) {
      return { ok: false, message: 'Этот логин уже занят.' }
    }
  }

  const passwordHash = await hashPassword(password)
  const created = await createCurator({
    name,
    email,
    passwordHash,
    username: username || undefined,
    city,
  })
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return {
    ok: true,
    message: `Куратор ${name} (${city}) создан.`,
    password,
    username: created.username ?? undefined,
  }
}

export async function setManagerStatusAction(
  id: string,
  status: 'active' | 'blocked',
): Promise<ActionResult> {
  await requireAdmin()
  const manager = await getManagerById(id)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }
  // The administrator is authenticated from env vars and is not a manager.
  // Blocking it would be meaningless and could lock the panel — refuse.
  if (isAdminIdentity(manager)) {
    return { ok: false, message: 'Администратора нельзя блокировать.' }
  }
  await updateManagerStatus(id, status)
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  const label = manager.role === 'curator' ? 'Куратор' : 'Менеджер'
  return {
    ok: true,
    message:
      status === 'blocked'
        ? `${label} заблокирован.`
        : `${label} разблокирован.`,
  }
}

export async function resetManagerPasswordAction(
  id: string,
): Promise<ActionResult> {
  await requireAdmin()
  const manager = await getManagerById(id)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }
  const password = genPassword()
  const passwordHash = await hashPassword(password)
  await updateManagerPassword(id, passwordHash)
  return {
    ok: true,
    message: `Новый пароль сгенерирован для ${manager.name}.`,
    password,
  }
}

export async function updateCuratorCityAction(
  id: string,
  city: string,
): Promise<ActionResult> {
  await requireAdmin()
  const account = await getManagerById(id)
  if (!account) return { ok: false, message: 'Аккаунт не найден.' }
  if (account.role !== 'curator') {
    return { ok: false, message: 'Город задаётся только для кураторов.' }
  }
  const trimmed = city.trim()
  if (!trimmed) {
    return { ok: false, message: 'Укажите город.' }
  }
  await updateCuratorCity(id, trimmed)
  revalidatePath('/admin/managers')
  return { ok: true, message: `Город обновлён: ${trimmed}.` }
}

export async function deleteManagerAction(id: string): Promise<ActionResult> {
  await requireAdmin()
  const manager = await getManagerById(id)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }
  if (isAdminIdentity(manager)) {
    return { ok: false, message: 'Администратора нельзя удалить.' }
  }
  await deleteManager(id)
  invalidateAnalytics()
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  const label = manager.role === 'curator' ? 'Куратор' : 'Менеджер'
  return { ok: true, message: `${label} ${manager.name} удалён.` }
}
