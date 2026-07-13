'use server'

import { revalidatePath } from 'next/cache'
import { hashPassword, requireAdmin } from '@/lib/auth'
import {
  createManager,
  deleteManager,
  getManagerByEmail,
  getManagerById,
  getManagerByIdentifier,
  sanitizeUsername,
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

function genPassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 12; i++) {
    out += chars[Math.floor(Math.random() * chars.length)]
  }
  return out
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
    return { ok: false, message: 'Менеджер с таким email уже существует.' }
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
  })
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return {
    ok: true,
    message: `Менеджер ${name} создан.`,
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
  if (!manager) return { ok: false, message: 'Manager not found.' }
  // The administrator is authenticated from env vars and is not a manager.
  // Blocking it would be meaningless and could lock the panel — refuse.
  if (isAdminIdentity(manager)) {
    return { ok: false, message: 'Администратора нельзя блокировать.' }
  }
  await updateManagerStatus(id, status)
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return {
    ok: true,
    message: status === 'blocked' ? 'Manager blocked.' : 'Manager unblocked.',
  }
}

export async function resetManagerPasswordAction(
  id: string,
): Promise<ActionResult> {
  await requireAdmin()
  const manager = await getManagerById(id)
  if (!manager) return { ok: false, message: 'Manager not found.' }
  const password = genPassword()
  const passwordHash = await hashPassword(password)
  await updateManagerPassword(id, passwordHash)
  return {
    ok: true,
    message: `New password generated for ${manager.name}.`,
    password,
  }
}

export async function deleteManagerAction(id: string): Promise<ActionResult> {
  await requireAdmin()
  const manager = await getManagerById(id)
  if (!manager) return { ok: false, message: 'Manager not found.' }
  if (isAdminIdentity(manager)) {
    return { ok: false, message: 'Администратора нельзя удалить.' }
  }
  await deleteManager(id)
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return { ok: true, message: `Manager ${manager.name} deleted.` }
}
