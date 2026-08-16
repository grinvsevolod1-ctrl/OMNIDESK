'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  addFinanceTask,
  createFinanceEntry,
  createFinanceResource,
  createFinanceSection,
  deleteFinanceEntry,
  deleteFinanceResource,
  deleteFinanceSection,
  deleteFinanceTask,
  moveFinanceEntry,
  renameFinanceSection,
  setFinanceTaskDone,
  updateFinanceEntry,
  updateFinanceResource,
  type FinanceCurrency,
} from '@/lib/finance'
import { toUsd, usdRateFor } from '@/lib/finance-types'
import { getUsdRates } from '@/lib/fx'
import {
  MAX_LABEL,
  MAX_NAME,
  MAX_NOTES,
  MAX_TITLE,
  parseCurrency,
  parseDate,
  parseOptionalDate,
  parseAmount,
  parseStatus,
  type FinanceResult,
} from './finance-shared'

/* -------------------------------------------------------------- */
/* Resources                                                       */
/* -------------------------------------------------------------- */

export async function createResourceAction(
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim().slice(0, MAX_NAME)
  const description = String(formData.get('description') ?? '')
    .trim()
    .slice(0, MAX_NOTES)
  // Валюта источника не назначается вручную — все суммы ведутся в USD.
  const currency: FinanceCurrency = 'USD'

  if (!name) return { ok: false, message: 'Укажите название источника.' }

  await createFinanceResource({ name, description, currency })
  // Источник — единая сущность «Обзора» и «Учёта»: обновляем обе вкладки.
  revalidatePath('/admin/finance')
  revalidatePath('/admin')
  return { ok: true, message: 'Источник добавлен.' }
}

export async function updateResourceAction(
  id: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim().slice(0, MAX_NAME)
  const description = String(formData.get('description') ?? '')
    .trim()
    .slice(0, MAX_NOTES)
  const currency: FinanceCurrency = 'USD'
  const archived = String(formData.get('archived') ?? '') === 'true'

  if (!id) return { ok: false, message: 'Источник не найден.' }
  if (!name) return { ok: false, message: 'Укажите название источника.' }

  await updateFinanceResource(id, { name, description, currency, archived })
  revalidatePath('/admin/finance')
  revalidatePath('/admin')
  return { ok: true, message: 'Источник обновлён.' }
}

export async function deleteResourceAction(
  id: string,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Источник не найден.' }
  await deleteFinanceResource(id)
  revalidatePath('/admin/finance')
  revalidatePath('/admin')
  return { ok: true, message: 'Источник удалён вместе со всеми данными.' }
}

/* -------------------------------------------------------------- */
/* Sections (expense tabs)                                         */
/* -------------------------------------------------------------- */

export async function createSectionAction(
  resourceId: string,
  name: string,
): Promise<FinanceResult> {
  await requireAdmin()
  const clean = name.trim().slice(0, MAX_NAME)
  if (!resourceId) return { ok: false, message: 'Источник не найден.' }
  if (!clean) return { ok: false, message: 'Укажите название вкладки.' }
  await createFinanceSection({ resourceId, name: clean })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Вкладка добавлена.' }
}

export async function renameSectionAction(
  id: string,
  name: string,
): Promise<FinanceResult> {
  await requireAdmin()
  const clean = name.trim().slice(0, MAX_NAME)
  if (!id) return { ok: false, message: 'Вкладка не найдена.' }
  if (!clean) return { ok: false, message: 'Укажите название вкладки.' }
  await renameFinanceSection(id, clean)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Вкладка переименована.' }
}

export async function deleteSectionAction(id: string): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Вкладка не найдена.' }
  await deleteFinanceSection(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Вкладка удалена вместе с записями.' }
}

/* -------------------------------------------------------------- */
/* Expense entries                                                 */
/* -------------------------------------------------------------- */

export async function createEntryAction(
  sectionId: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!sectionId) return { ok: false, message: 'Вкладка не найдена.' }

  const title = String(formData.get('title') ?? '').trim().slice(0, MAX_TITLE)
  const vendor = String(formData.get('vendor') ?? '').trim().slice(0, MAX_NAME)
  const status = parseStatus(String(formData.get('status') ?? 'planned'))
  const notes = String(formData.get('notes') ?? '').trim().slice(0, MAX_NOTES)
  const entryDate = parseDate(String(formData.get('entryDate') ?? ''))
  const dueDate = parseOptionalDate(String(formData.get('dueDate') ?? ''))
  const origAmount = parseAmount(String(formData.get('amount') ?? '0'))
  const origCurrency = parseCurrency(String(formData.get('currency') ?? 'USD'))

  if (!title) return { ok: false, message: 'Укажите название расхода.' }
  if (Number.isNaN(origAmount)) {
    return { ok: false, message: 'Введите корректную сумму (не меньше 0).' }
  }

  // Замораживаем курс на момент добавления — сумма сразу переводится в USD.
  const rates = await getUsdRates()
  const amount = toUsd(origAmount, origCurrency, rates)
  const fxRate = usdRateFor(origCurrency, rates)

  await createFinanceEntry({
    sectionId,
    title,
    vendor,
    amount,
    origAmount,
    origCurrency,
    fxRate,
    status,
    notes,
    entryDate,
    dueDate,
  })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Расход добавлен.' }
}

export async function updateEntryAction(
  id: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись не найдена.' }

  const title = String(formData.get('title') ?? '').trim().slice(0, MAX_TITLE)
  const vendor = String(formData.get('vendor') ?? '').trim().slice(0, MAX_NAME)
  const status = parseStatus(String(formData.get('status') ?? 'planned'))
  const notes = String(formData.get('notes') ?? '').trim().slice(0, MAX_NOTES)
  const entryDate = parseDate(String(formData.get('entryDate') ?? ''))
  const dueDate = parseOptionalDate(String(formData.get('dueDate') ?? ''))
  const origAmount = parseAmount(String(formData.get('amount') ?? '0'))
  const origCurrency = parseCurrency(String(formData.get('currency') ?? 'USD'))

  if (!title) return { ok: false, message: 'Укажите название расхода.' }
  if (Number.isNaN(origAmount)) {
    return { ok: false, message: 'Введите корректную сумму (не меньше 0).' }
  }

  // При изменении суммы курс замораживаем заново по текущему.
  const rates = await getUsdRates()
  const amount = toUsd(origAmount, origCurrency, rates)
  const fxRate = usdRateFor(origCurrency, rates)

  await updateFinanceEntry(id, {
    title,
    vendor,
    amount,
    origAmount,
    origCurrency,
    fxRate,
    status,
    notes,
    entryDate,
    dueDate,
  })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Расход обновлён.' }
}

export async function moveEntryAction(
  id: string,
  sectionId: string,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id || !sectionId) {
    return { ok: false, message: 'Не удалось перенести запись.' }
  }
  await moveFinanceEntry(id, sectionId)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Запись перенесена.' }
}

export async function deleteEntryAction(id: string): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись не найдена.' }
  await deleteFinanceEntry(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Расход удалён.' }
}

/* -------------------------------------------------------------- */
/* Checklist tasks                                                 */
/* -------------------------------------------------------------- */

export async function addTaskAction(
  entryId: string,
  label: string,
): Promise<FinanceResult> {
  await requireAdmin()
  const clean = label.trim().slice(0, MAX_LABEL)
  if (!entryId) return { ok: false, message: 'Запись не найдена.' }
  if (!clean) return { ok: false, message: 'Введите текст пункта.' }
  await addFinanceTask({ entryId, label: clean })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Пункт добавлен.' }
}

export async function toggleTaskAction(
  id: string,
  done: boolean,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Пункт не найден.' }
  await setFinanceTaskDone(id, done)
  revalidatePath('/admin/finance')
  return { ok: true, message: done ? 'Пункт выполнен.' : 'Пункт снят.' }
}

export async function deleteTaskAction(id: string): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Пункт не найден.' }
  await deleteFinanceTask(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Пункт удалён.' }
}
