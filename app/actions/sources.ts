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

/** Сводка предыдущего периода для дельт «к прошлому периоду». */
export interface PrevPeriodStats {
  people: number
  liquid: number
  income: number
  expense: number
}

/** Тот же интервал, сдвинутый назад на собственную длину: [from-len, from). */
function previousRange(fromISO: string, toISO: string): [string, string] {
  const from = new Date(fromISO).getTime()
  const len = new Date(toISO).getTime() - from
  return [new Date(from - len).toISOString(), new Date(from).toISOString()]
}

export async function getSourcesOverviewAction(
  fromISO: string,
  toISO: string,
  tzOffsetMinutes = 0,
): Promise<{
  ok: boolean
  data?: SourcesOverview
  /** id источника (или '__unassigned__') -> сводка прошлого периода. */
  prev?: Record<string, PrevPeriodStats>
  message?: string
}> {
  await requireAdmin()
  try {
    const [prevFrom, prevTo] = previousRange(fromISO, toISO)
    // Оба вызова идут через 60-сек кэш агрегатов — дельты почти бесплатны.
    const [data, prevData] = await Promise.all([
      getSourcesOverview(fromISO, toISO, tzOffsetMinutes),
      getSourcesOverview(prevFrom, prevTo, tzOffsetMinutes),
    ])
    const prev: Record<string, PrevPeriodStats> = {}
    for (const it of prevData.items) {
      prev[it.id] = {
        people: it.stats.people,
        liquid: it.stats.liquid,
        income: it.stats.income,
        expense: it.stats.expense,
      }
    }
    if (prevData.unassigned) {
      prev['__unassigned__'] = {
        people: prevData.unassigned.stats.people,
        liquid: prevData.unassigned.stats.liquid,
        income: prevData.unassigned.stats.income,
        expense: prevData.unassigned.stats.expense,
      }
    }
    return { ok: true, data, prev }
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
): Promise<{
  ok: boolean
  data?: SourceDetail | null
  /** Сводка прошлого периода для дельт (undefined, если источник не найден). */
  prev?: PrevPeriodStats
  message?: string
}> {
  await requireAdmin()
  try {
    const [prevFrom, prevTo] = previousRange(fromISO, toISO)
    const [data, prevDetail] = await Promise.all([
      getSourceDetail(id, fromISO, toISO, tzOffsetMinutes),
      getSourceDetail(id, prevFrom, prevTo, tzOffsetMinutes),
    ])
    const prev = prevDetail
      ? {
          people: prevDetail.funnel.people,
          liquid: prevDetail.funnel.liquid,
          income: prevDetail.finance.income,
          expense: prevDetail.finance.expense,
        }
      : undefined
    return { ok: true, data, prev }
  } catch (err) {
    console.error('[sources] detail failed:', err)
    return { ok: false, message: 'Не удалось загрузить детали источника.' }
  }
}
