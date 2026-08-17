'use server'

/**
 * Админ: управление руководителями (role = 'head', миграция 141) —
 * создание учётки, состав группы кураторов, право «просмотр» /
 * «просмотр и редактирование». Блокировка/сброс пароля/удаление — общие
 * экшены аккаунтов из app/actions/managers.ts.
 */
import { revalidatePath } from 'next/cache'
import { hashPassword, requireAdmin } from '@/lib/auth'
import { generatePassword } from '@/lib/crypto'
import {
  createManager,
  getManagerByEmail,
  getManagerById,
  getManagerByIdentifier,
  listCurators,
  sanitizeUsername,
} from '@/lib/data'
import {
  listCuratorsOfHead,
  listHeads,
  mapCuratorHeads,
  setHeadCanEdit,
  setHeadCurators,
} from '@/lib/data/heads'
import { writeAudit } from '@/lib/data/audit'
import type { ActionResult as BaseActionResult } from '@/lib/types'

export interface HeadActionResult extends BaseActionResult {
  password?: string
  username?: string
}

/** Admin: руководители + состав их групп + все кураторы (для назначения). */
export async function listHeadsAdminAction() {
  await requireAdmin()
  const [heads, curators, curatorHeads] = await Promise.all([
    listHeads(),
    listCurators(),
    mapCuratorHeads(),
  ])
  const groups = await Promise.all(
    heads.map(async (h) => ({
      head: h,
      curators: await listCuratorsOfHead(h.id),
    })),
  )
  return {
    groups,
    allCurators: curators.map((c) => ({
      ...c,
      headId: curatorHeads.get(c.id)?.headId ?? null,
      headName: curatorHeads.get(c.id)?.headName ?? null,
    })),
  }
}

/** Admin: создать учётку руководителя. */
export async function createHeadAction(
  formData: FormData,
): Promise<HeadActionResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const usernameRaw = String(formData.get('username') ?? '').trim()
  const canEdit = String(formData.get('canEdit') ?? '') === 'true'
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
    role: 'head',
  })
  if (canEdit) await setHeadCanEdit(created.id, true)
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'head.create',
    entityType: 'manager',
    entityId: created.id,
    details: { name, email, canEdit },
  })
  revalidatePath('/admin/heads')
  return {
    ok: true,
    message: `Руководитель ${name} создан.`,
    password,
    username: created.username ?? undefined,
  }
}

/** Admin: переключить право руководителя «просмотр» / «редактирование». */
export async function setHeadCanEditAction(
  headId: string,
  canEdit: boolean,
): Promise<BaseActionResult> {
  await requireAdmin()
  const head = await getManagerById(headId)
  if (!head || head.role !== 'head') {
    return { ok: false, message: 'Руководитель не найден.' }
  }
  await setHeadCanEdit(headId, canEdit)
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'head.permission_update',
    entityType: 'manager',
    entityId: headId,
    details: { name: head.name, canEdit },
  })
  revalidatePath('/admin/heads')
  return {
    ok: true,
    message: canEdit
      ? 'Выдано право «просмотр и редактирование».'
      : 'Оставлено право «только просмотр».',
  }
}

/** Admin: полная замена состава группы руководителя. */
export async function setHeadCuratorsAction(
  headId: string,
  curatorIds: string[],
): Promise<BaseActionResult> {
  await requireAdmin()
  const head = await getManagerById(headId)
  if (!head || head.role !== 'head') {
    return { ok: false, message: 'Руководитель не найден.' }
  }
  await setHeadCurators(headId, curatorIds)
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'head.curators_update',
    entityType: 'manager',
    entityId: headId,
    details: { name: head.name, curatorIds },
  })
  revalidatePath('/admin/heads')
  return { ok: true, message: 'Состав группы обновлён.' }
}
