'use server'

/**
 * Канонические server actions «Источника» — единой сущности проекта
 * (finance_resources + source_channels). Новый «Обзор» работает только через
 * этот модуль; старые actions (groups.ts, finance-workspace.ts) остаются
 * рабочими обёртками над теми же данными.
 */
import { revalidatePath } from 'next/cache'
import { invalidateAnalytics } from '@/lib/analytics-cache'
import { requireAdmin } from '@/lib/auth'
import {
  createSource,
  deleteSource,
  getSourceDetail,
  getSourcesOverview,
  updateSource,
  type SourceDetail,
  type SourcesOverview,
} from '@/lib/data/sources'

export interface SourceActionResult {
  ok: boolean
  message: string
  id?: string
}

function revalidateSourceSurfaces(): void {
  invalidateAnalytics()
  // Источник — единая сущность: меняется и Обзор, и Учёт.
  revalidatePath('/admin')
  revalidatePath('/admin/finance')
}

export async function createSourceAction(
  name: string,
  channelIds: string[] = [],
): Promise<SourceActionResult> {
  await requireAdmin()
  const clean = name.trim()
  if (!clean) return { ok: false, message: 'Введите название источника.' }
  try {
    const created = await createSource(clean, channelIds)
    revalidateSourceSurfaces()
    return { ok: true, message: 'Источник создан.', id: created.id }
  } catch (err) {
    console.error('[sources] create failed:', err)
    return { ok: false, message: 'Не удалось создать источник.' }
  }
}

export async function renameSourceAction(
  id: string,
  name: string,
): Promise<SourceActionResult> {
  await requireAdmin()
  const clean = name.trim()
  if (!clean) return { ok: false, message: 'Введите название источника.' }
  try {
    await updateSource(id, { name: clean })
    revalidateSourceSurfaces()
    return { ok: true, message: 'Источник переименован.' }
  } catch (err) {
    console.error('[sources] rename failed:', err)
    return { ok: false, message: 'Не удалось переименовать источник.' }
  }
}

export async function setSourceChannelsAction(
  id: string,
  channelIds: string[],
): Promise<SourceActionResult> {
  await requireAdmin()
  try {
    await updateSource(id, { channelIds })
    revalidateSourceSurfaces()
    return { ok: true, message: 'Каналы источника обновлены.' }
  } catch (err) {
    console.error('[sources] set channels failed:', err)
    return { ok: false, message: 'Не удалось обновить каналы.' }
  }
}

export async function deleteSourceAction(
  id: string,
): Promise<SourceActionResult> {
  await requireAdmin()
  try {
    await deleteSource(id)
    revalidateSourceSurfaces()
    return { ok: true, message: 'Источник удалён.' }
  } catch (err) {
    console.error('[sources] delete failed:', err)
    return { ok: false, message: 'Не удалось удалить источник.' }
  }
}

/* ------------------------------- Чтение ---------------------------------- */

export async function getSourcesOverviewAction(
  fromISO: string,
  toISO: string,
  tzOffsetMinutes = 0,
): Promise<{ ok: boolean; data?: SourcesOverview; message?: string }> {
  await requireAdmin()
  try {
    const data = await getSourcesOverview(fromISO, toISO, tzOffsetMinutes)
    return { ok: true, data }
  } catch (err) {
    console.error('[sources] overview failed:', err)
    return { ok: false, message: 'Не удалось загрузить источники.' }
  }
}

export async function getSourceDetailAction(
  id: string,
  fromISO: string,
  toISO: string,
  tzOffsetMinutes = 0,
): Promise<{ ok: boolean; data?: SourceDetail | null; message?: string }> {
  await requireAdmin()
  try {
    const data = await getSourceDetail(id, fromISO, toISO, tzOffsetMinutes)
    return { ok: true, data }
  } catch (err) {
    console.error('[sources] detail failed:', err)
    return { ok: false, message: 'Не удалось загрузить детали источника.' }
  }
}
