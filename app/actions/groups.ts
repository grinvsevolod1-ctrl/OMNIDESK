'use server'

import { revalidatePath } from 'next/cache'
import { invalidateAnalytics } from '@/lib/analytics-cache'
import { requireAdmin } from '@/lib/auth'
import {
  createSourceGroup,
  deleteSourceGroup,
  getGroupAnalytics,
  updateSourceGroup,
  type GroupAnalytics,
} from '@/lib/data'

export interface GroupActionResult {
  ok: boolean
  message: string
}

export async function createSourceGroupAction(
  name: string,
  channelIds: string[],
): Promise<GroupActionResult> {
  await requireAdmin()
  const clean = name.trim()
  if (!clean) return { ok: false, message: 'Введите название источника.' }
  try {
    await createSourceGroup(clean, channelIds)
    // A source group defines how channels roll up in getGroupAnalytics, so drop
    // the analytics cache alongside the page revalidations.
    invalidateAnalytics()
    // Источник теперь единая сущность — обновляем и Обзор, и Учёт.
    revalidatePath('/admin')
    revalidatePath('/admin/finance')
    return { ok: true, message: 'Источник создан.' }
  } catch (err) {
    console.error('[groups] create failed:', err)
    return { ok: false, message: 'Не удалось создать источник.' }
  }
}

export async function updateSourceGroupAction(
  id: string,
  name: string,
  channelIds: string[],
): Promise<GroupActionResult> {
  await requireAdmin()
  const clean = name.trim()
  if (!clean) return { ok: false, message: 'Введите название источника.' }
  try {
    await updateSourceGroup(id, { name: clean, channelIds })
    invalidateAnalytics()
    revalidatePath('/admin')
    revalidatePath('/admin/finance')
    return { ok: true, message: 'Источник обновлён.' }
  } catch (err) {
    console.error('[groups] update failed:', err)
    return { ok: false, message: 'Не удалось обновить источник.' }
  }
}

export async function deleteSourceGroupAction(
  id: string,
): Promise<GroupActionResult> {
  await requireAdmin()
  try {
    await deleteSourceGroup(id)
    invalidateAnalytics()
    revalidatePath('/admin')
    revalidatePath('/admin/finance')
    return { ok: true, message: 'Источник удалён.' }
  } catch (err) {
    console.error('[groups] delete failed:', err)
    return { ok: false, message: 'Не удалось удалить источник.' }
  }
}

/**
 * Fetch the detailed "who wrote in" report for a group over a date range.
 * `from`/`to` are ISO strings; `to` is exclusive.
 */
export async function getGroupAnalyticsAction(
  groupId: string,
  from: string,
  to: string,
  tzOffsetMinutes = 0,
): Promise<{ ok: boolean; data?: GroupAnalytics; message?: string }> {
  await requireAdmin()
  try {
    const data = await getGroupAnalytics(groupId, from, to, tzOffsetMinutes)
    return { ok: true, data }
  } catch (err) {
    console.error('[groups] analytics failed:', err)
    return { ok: false, message: 'Не удалось загрузить отчёт.' }
  }
}
