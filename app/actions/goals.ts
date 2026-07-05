'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  createConversionGoal,
  deleteConversionGoal,
  updateConversionGoal,
  type GoalMessenger,
} from '@/lib/data'

export interface GoalResult {
  ok: boolean
  message: string
}

const MESSENGERS: GoalMessenger[] = ['any', 'telegram', 'whatsapp']

function normalizeMessenger(value: unknown): GoalMessenger | null {
  return MESSENGERS.includes(value as GoalMessenger)
    ? (value as GoalMessenger)
    : null
}

/** Admin: create a new conversion goal that counts messenger transitions. */
export async function createGoalAction(input: {
  name: string
  messenger: GoalMessenger
}): Promise<GoalResult> {
  await requireAdmin()
  const name = String(input.name ?? '').trim()
  if (name.length < 2) {
    return { ok: false, message: 'Укажите название цели (минимум 2 символа).' }
  }
  const messenger = normalizeMessenger(input.messenger)
  if (!messenger) return { ok: false, message: 'Некорректный мессенджер.' }

  await createConversionGoal({ name, messenger })
  revalidatePath('/admin/analytics')
  return { ok: true, message: 'Цель создана.' }
}

/** Admin: update a goal (rename, change messenger filter, toggle active). */
export async function updateGoalAction(
  id: string,
  input: { name?: string; messenger?: GoalMessenger; active?: boolean },
): Promise<GoalResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Цель не найдена.' }

  const patch: { name?: string; messenger?: GoalMessenger; active?: boolean } = {}
  if (typeof input.name === 'string') {
    const name = input.name.trim()
    if (name.length < 2) {
      return { ok: false, message: 'Название слишком короткое.' }
    }
    patch.name = name
  }
  if (input.messenger !== undefined) {
    const messenger = normalizeMessenger(input.messenger)
    if (!messenger) return { ok: false, message: 'Некорректный мессенджер.' }
    patch.messenger = messenger
  }
  if (typeof input.active === 'boolean') patch.active = input.active

  await updateConversionGoal(id, patch)
  revalidatePath('/admin/analytics')
  return { ok: true, message: 'Цель обновлена.' }
}

/** Admin: delete a conversion goal. */
export async function deleteGoalAction(id: string): Promise<GoalResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Цель не найдена.' }
  await deleteConversionGoal(id)
  revalidatePath('/admin/analytics')
  return { ok: true, message: 'Цель удалена.' }
}
