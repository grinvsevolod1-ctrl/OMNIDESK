'use server'

import { requireManager } from '@/lib/auth'
import {
  getManagerActivityAnalytics,
  type ManagerActivityAnalytics,
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
