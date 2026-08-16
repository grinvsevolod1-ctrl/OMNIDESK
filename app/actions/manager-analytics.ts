'use server'

import { requireManager } from '@/lib/auth'
import {
  getManagerActivityAnalytics,
  getManagerChannelsOverview,
  type ManagerActivityAnalytics,
  type ManagerChannelsOverview,
} from '@/lib/data'

/**
 * Activity report for the CURRENT manager over a date range. Always scoped to
 * the session's own manager id — a manager can never query another manager's
 * data. `from`/`to` are ISO strings; `to` is exclusive.
 */
export async function getManagerActivityAnalyticsAction(
  from: string,
  to: string,
  tzOffsetMinutes = 0,
): Promise<{ ok: boolean; data?: ManagerActivityAnalytics; message?: string }> {
  const session = await requireManager()
  try {
    const data = await getManagerActivityAnalytics(
      session.sub,
      from,
      to,
      tzOffsetMinutes,
    )
    return { ok: true, data }
  } catch (err) {
    console.error('[manager-analytics] failed:', err)
    return { ok: false, message: 'Не удалось загрузить отчёт.' }
  }
}

/** Прошлый период той же длины, вплотную к текущему: [from-len, from). */
function previousRange(fromISO: string, toISO: string): [string, string] {
  const from = new Date(fromISO).getTime()
  const to = new Date(toISO).getTime()
  const len = Math.max(1, to - from)
  return [new Date(from - len).toISOString(), new Date(from).toISOString()]
}

/**
 * Обзор каналов ТЕКУЩЕГО менеджера за период + сводка прошлого периода для
 * дельт. Всегда скоуплен на собственный manager id из сессии.
 */
export async function getManagerChannelsOverviewAction(
  from: string,
  to: string,
  tzOffsetMinutes = 0,
): Promise<{
  ok: boolean
  data?: ManagerChannelsOverview
  /** id канала -> люди за прошлый период (для дельты на карточке). */
  prev?: Record<string, { people: number }>
  message?: string
}> {
  const session = await requireManager()
  try {
    const [prevFrom, prevTo] = previousRange(from, to)
    // Оба вызова идут через 60-сек кэш агрегатов — дельты почти бесплатны.
    const [data, prevData] = await Promise.all([
      getManagerChannelsOverview(session.sub, from, to, tzOffsetMinutes),
      getManagerChannelsOverview(session.sub, prevFrom, prevTo, tzOffsetMinutes),
    ])
    const prev: Record<string, { people: number }> = {}
    for (const it of prevData.items) prev[it.id] = { people: it.people }
    return { ok: true, data, prev }
  } catch (err) {
    console.error('[manager-analytics] channels overview failed:', err)
    return { ok: false, message: 'Не удалось загрузить обзор каналов.' }
  }
}
