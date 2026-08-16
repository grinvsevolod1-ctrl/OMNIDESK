'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  addFinanceAdStat,
  addFinanceAdTopup,
  createFinanceAdAccount,
  deleteFinanceAdAccount,
  deleteFinanceAdStat,
  deleteFinanceAdTopup,
  updateFinanceAdAccount,
} from '@/lib/finance'
import { syncAdAccount } from '@/lib/ads-yandex'
import {
  MAX_NAME,
  MAX_NOTES,
  MAX_REF,
  parseAdStatus,
  parseAmount,
  parseCount,
  parseCurrency,
  parseDate,
  parsePlatform,
  type FinanceResult,
} from './finance-shared'

/* -------------------------------------------------------------- */
/* Ad accounts                                                     */
/* -------------------------------------------------------------- */

export async function createAdAccountAction(
  resourceId: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!resourceId) return { ok: false, message: 'Ресурс не найден.' }

  const name = String(formData.get('name') ?? '').trim().slice(0, MAX_NAME)
  const platform = parsePlatform(String(formData.get('platform') ?? 'other'))
  const status = parseAdStatus(String(formData.get('status') ?? 'active'))
  const accountRef = String(formData.get('accountRef') ?? '')
    .trim()
    .slice(0, MAX_REF)
  const currency = parseCurrency(String(formData.get('currency') ?? 'RUB'))
  const note = String(formData.get('note') ?? '').trim().slice(0, MAX_NOTES)
  const externalEnabled = String(formData.get('externalEnabled') ?? '') === 'on'
  const yandexLogin = String(formData.get('yandexLogin') ?? '')
    .trim()
    .slice(0, MAX_REF)
  const yandexToken = String(formData.get('yandexToken') ?? '').trim()

  if (!name) return { ok: false, message: 'Укажите название кабинета.' }
  if (externalEnabled && !yandexToken) {
    return {
      ok: false,
      message: 'Для интеграции с Яндекс.Директом укажите OAuth-токен.',
    }
  }

  await createFinanceAdAccount({
    resourceId,
    name,
    platform,
    status,
    accountRef,
    currency,
    note,
    externalEnabled,
    yandexLogin,
    yandexToken,
  })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Кабинет добавлен.' }
}

export async function updateAdAccountAction(
  id: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Кабинет не найден.' }

  const name = String(formData.get('name') ?? '').trim().slice(0, MAX_NAME)
  const platform = parsePlatform(String(formData.get('platform') ?? 'other'))
  const status = parseAdStatus(String(formData.get('status') ?? 'active'))
  const accountRef = String(formData.get('accountRef') ?? '')
    .trim()
    .slice(0, MAX_REF)
  const currency = parseCurrency(String(formData.get('currency') ?? 'RUB'))
  const note = String(formData.get('note') ?? '').trim().slice(0, MAX_NOTES)
  const externalEnabled = String(formData.get('externalEnabled') ?? '') === 'on'
  const yandexLogin = String(formData.get('yandexLogin') ?? '')
    .trim()
    .slice(0, MAX_REF)
  // Пустая строка = не менять сохранённый токен.
  const yandexToken = String(formData.get('yandexToken') ?? '').trim()

  if (!name) return { ok: false, message: 'Укажите название кабинета.' }

  await updateFinanceAdAccount(id, {
    name,
    platform,
    status,
    accountRef,
    currency,
    note,
    externalEnabled,
    yandexLogin,
    yandexToken,
  })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Кабинет обновлён.' }
}

/* -------------------------------------------------------------- */
/* Ad sync (Яндекс.Директ)                                         */
/* -------------------------------------------------------------- */

/**
 * Подтянуть свежую статистику кабинета из Яндекс.Директа. Тянутся кумулятивные
 * метрики за всю историю; ручные корректировки с god-страницы сохраняются —
 * новые данные приплюсовываются поверх зафиксированного baseline.
 */
export async function syncAdAccountAction(
  accountId: string,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!accountId) return { ok: false, message: 'Кабинет не найден.' }

  const result = await syncAdAccount(accountId)
  revalidatePath('/admin/finance')
  return { ok: result.ok, message: result.message }
}

export async function deleteAdAccountAction(
  id: string,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Кабинет не найден.' }
  await deleteFinanceAdAccount(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Кабинет удалён вместе с историей.' }
}

/* -------------------------------------------------------------- */
/* Ad top-ups                                                      */
/* -------------------------------------------------------------- */

export async function addAdTopupAction(
  accountId: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!accountId) return { ok: false, message: 'Кабинет не найден.' }

  const amount = parseAmount(String(formData.get('amount') ?? '0'))
  const topupDate = parseDate(String(formData.get('topupDate') ?? ''))
  const note = String(formData.get('note') ?? '').trim().slice(0, MAX_NOTES)

  if (Number.isNaN(amount) || amount <= 0) {
    return { ok: false, message: 'Введите сумму пополнения больше 0.' }
  }

  await addFinanceAdTopup({ accountId, amount, topupDate, note })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Баланс пополнен.' }
}

export async function deleteAdTopupAction(id: string): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Пополнение не найдено.' }
  await deleteFinanceAdTopup(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Пополнение удалено.' }
}

/* -------------------------------------------------------------- */
/* Ad stats                                                        */
/* -------------------------------------------------------------- */

export async function addAdStatAction(
  accountId: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!accountId) return { ok: false, message: 'Кабинет не найден.' }

  const periodStart = parseDate(String(formData.get('periodStart') ?? ''))
  const periodEnd = parseDate(String(formData.get('periodEnd') ?? ''))
  const impressions = parseCount(String(formData.get('impressions') ?? '0'))
  const clicks = parseCount(String(formData.get('clicks') ?? '0'))
  const leads = parseCount(String(formData.get('leads') ?? '0'))
  const spend = parseAmount(String(formData.get('spend') ?? '0'))
  const note = String(formData.get('note') ?? '').trim().slice(0, MAX_NOTES)

  if (Number.isNaN(impressions) || Number.isNaN(clicks) || Number.isNaN(leads)) {
    return { ok: false, message: 'Показы, клики и лиды должны быть целыми ≥ 0.' }
  }
  if (Number.isNaN(spend)) {
    return { ok: false, message: 'Введите корректный расход (не меньше 0).' }
  }
  if (periodEnd < periodStart) {
    return { ok: false, message: 'Конец периода раньше начала.' }
  }

  await addFinanceAdStat({
    accountId,
    periodStart,
    periodEnd,
    impressions,
    clicks,
    leads,
    spend,
    note,
  })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Статистика внесена.' }
}

export async function deleteAdStatAction(id: string): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись статистики не найдена.' }
  await deleteFinanceAdStat(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Статистика удалена.' }
}
