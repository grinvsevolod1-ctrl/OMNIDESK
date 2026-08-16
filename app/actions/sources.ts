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
  assignChannelSource,
  createSource,
  deleteSource,
  getSourceDetail,
  getSourcesOverview,
  listPanelChannels,
  listSources,
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
  description = '',
): Promise<SourceActionResult> {
  await requireAdmin()
  const clean = name.trim()
  if (!clean) return { ok: false, message: 'Введите название источника.' }
  try {
    const created = await createSource(clean, channelIds, description)
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

/* --------------------- Источник отдельного канала ------------------------ */

export interface SourceSelectItem {
  id: string
  name: string
  channelIds: string[]
}

export interface ChannelSelectItem {
  id: string
  name: string
  type: string
  /** Источник, которому канал принадлежит сейчас (null — свободен). */
  sourceId: string | null
}

/**
 * Источники + все панельные каналы для селекта «Источник» в настройках
 * канала и единого диалога создания. SWR на клиенте дедуплицирует вызов
 * между строками таблицы аккаунтов.
 */
export async function listSourcesForSelectAction(): Promise<{
  ok: boolean
  data?: { sources: SourceSelectItem[]; channels: ChannelSelectItem[] }
  message?: string
}> {
  await requireAdmin()
  try {
    const [sources, channelRows] = await Promise.all([
      listSources(),
      listPanelChannels(),
    ])
    const ownerByChannel = new Map<string, string>()
    for (const s of sources)
      for (const c of s.channels) ownerByChannel.set(c.id, s.id)
    return {
      ok: true,
      data: {
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          channelIds: s.channels.map((c) => c.id),
        })),
        channels: channelRows.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          sourceId: ownerByChannel.get(c.id) ?? null,
        })),
      },
    }
  } catch (err) {
    console.error('[sources] list for select failed:', err)
    return { ok: false, message: 'Не удалось загрузить источники.' }
  }
}

/** Привязать канал к источнику (null — отвязать). Канал ∈ максимум одному. */
export async function assignChannelSourceAction(
  channelId: string,
  sourceId: string | null,
): Promise<SourceActionResult> {
  await requireAdmin()
  if (!channelId) return { ok: false, message: 'Канал не найден.' }
  try {
    await assignChannelSource(channelId, sourceId)
    revalidateSourceSurfaces()
    revalidatePath('/admin/accounts')
    return {
      ok: true,
      message: sourceId
        ? 'Канал привязан к источнику.'
        : 'Канал отвязан от источника.',
    }
  } catch (err) {
    console.error('[sources] assign channel failed:', err)
    return { ok: false, message: 'Не удалось изменить источник канала.' }
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
