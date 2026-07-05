'use server'

import { revalidatePath } from 'next/cache'
import { hashPassword, requireAdmin } from '@/lib/auth'
import {
  createManager,
  deleteManager,
  getManagerByEmail,
  getManagerById,
  updateManagerPassword,
  updateManagerStatus,
} from '@/lib/data'

export interface ActionResult {
  ok: boolean
  message: string
  password?: string
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
  let password = String(formData.get('password') ?? '')

  if (!name || !email) {
    return { ok: false, message: 'Name and email are required.' }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'Enter a valid email address.' }
  }
  if (!password) {
    password = genPassword()
  } else if (password.length < 8) {
    return { ok: false, message: 'Password must be at least 8 characters.' }
  }

  const existing = await getManagerByEmail(email)
  if (existing) {
    return { ok: false, message: 'A manager with this email already exists.' }
  }

  const passwordHash = await hashPassword(password)
  await createManager({ name, email, passwordHash })
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return {
    ok: true,
    message: `Manager ${name} created.`,
    password,
  }
}

export async function setManagerStatusAction(
  id: string,
  status: 'active' | 'blocked',
): Promise<ActionResult> {
  await requireAdmin()
  const manager = await getManagerById(id)
  if (!manager) return { ok: false, message: 'Manager not found.' }
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
  await deleteManager(id)
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return { ok: true, message: `Manager ${manager.name} deleted.` }
}
