'use server'

import {
  revalidatePath,
} from 'next/cache'
import {
  requireAdmin,
} from '@/lib/auth'
import {
  AD_METRIC_KEYS,
  AD_METRIC_LABELS,
  clearAdOverride,
  setAdOverride,
  type AdMetricKey,
} from '@/lib/finance'
import {
  syncAdAccount,
} from '@/lib/ads-yandex'
import {
  ADMIN_PATH,
  type ActionResult,
} from './shared'

/* ===================================================================== */
/*  Ad-account metric overrides (god-only control of advertising stats)   */
/* ===================================================================== */

/**
 * Зафиксировать «свою» цифру по метрике кабинета. Мы сохраняем и введённое
 * значение, и текущий baseline из Яндекса, поэтому дальше показывается
 * value + прирост Яндекса относительно baseline (новые данные приплюсовываются).
 */
export async function secretSetAdOverrideAction(
  accountId: string,
  metric: string,
  value: number,
): Promise<ActionResult> {
  await requireAdmin()
  if (!accountId) return { ok: false, message: 'Кабинет не найден.' }
  if (!AD_METRIC_KEYS.includes(metric as AdMetricKey)) {
    return { ok: false, message: 'Неизвестная метрика.' }
  }
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, message: 'Значение должно быть числом ≥ 0.' }
  }

  await setAdOverride(accountId, metric as AdMetricKey, value)
  revalidatePath(ADMIN_PATH)
  revalidatePath('/admin/finance')
  return {
    ok: true,
    message: `${AD_METRIC_LABELS[metric as AdMetricKey]}: значение зафиксировано.`,
  }
}

/** Снять корректировку — метрика снова показывает данные Яндекса как есть. */
export async function secretClearAdOverrideAction(
  accountId: string,
  metric: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!accountId) return { ok: false, message: 'Кабинет не найден.' }
  if (!AD_METRIC_KEYS.includes(metric as AdMetricKey)) {
    return { ok: false, message: 'Неизвестная метрика.' }
  }

  await clearAdOverride(accountId, metric as AdMetricKey)
  revalidatePath(ADMIN_PATH)
  revalidatePath('/admin/finance')
  return {
    ok: true,
    message: `${AD_METRIC_LABELS[metric as AdMetricKey]}: корректировка снята.`,
  }
}

/** Принудительная синхронизация кабинета с Яндекс.Директом из god-консоли. */
export async function secretSyncAdAccountAction(
  accountId: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!accountId) return { ok: false, message: 'Кабинет не найден.' }
  const result = await syncAdAccount(accountId)
  revalidatePath(ADMIN_PATH)
  revalidatePath('/admin/finance')
  return { ok: result.ok, message: result.message }
}
