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
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  FINANCE_ENTRY_TYPES,
  type FinanceCurrency,
  type FinanceEntryStatus,
  type FinanceEntryType,
} from '@/lib/finance'

export interface FinanceResult {
  ok: boolean
  message: string
}

const MAX_NAME = 120
const MAX_TITLE = 200
const MAX_NOTES = 4000
const MAX_LABEL = 300

function parseCurrency(raw: string): FinanceCurrency {
  return FINANCE_CURRENCIES.includes(raw as FinanceCurrency)
    ? (raw as FinanceCurrency)
    : 'USDT'
}

function parseType(raw: string): FinanceEntryType {
  return FINANCE_ENTRY_TYPES.includes(raw as FinanceEntryType)
    ? (raw as FinanceEntryType)
    : 'expense'
}

function parseStatus(raw: string): FinanceEntryStatus {
  return FINANCE_ENTRY_STATUSES.includes(raw as FinanceEntryStatus)
    ? (raw as FinanceEntryStatus)
    : 'planned'
}

function parseAmount(raw: string): number {
  // Accept comma decimals ("1 200,50") and stray spaces.
  const normalized = raw.replace(/\s+/g, '').replace(',', '.')
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return Number.NaN
  // Round to 2 decimals to match numeric(14,2).
  return Math.round(value * 100) / 100
}

function parseDate(raw: string): string {
  // Expect YYYY-MM-DD from <input type="date">; fall back to today.
  return /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : new Date().toISOString().slice(0, 10)
}

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
  const currency = parseCurrency(String(formData.get('currency') ?? 'USDT'))

  if (!name) return { ok: false, message: 'Укажите название ресурса.' }

  await createFinanceResource({ name, description, currency })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Ресурс добавлен.' }
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
  const currency = parseCurrency(String(formData.get('currency') ?? 'USDT'))
  const archived = String(formData.get('archived') ?? '') === 'true'

  if (!id) return { ok: false, message: 'Ресурс не найден.' }
  if (!name) return { ok: false, message: 'Укажите название ресурса.' }

  await updateFinanceResource(id, { name, description, currency, archived })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Ресурс обновлён.' }
}

export async function deleteResourceAction(
  id: string,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Ресурс не найден.' }
  await deleteFinanceResource(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Ресурс удалён вместе со всеми записями.' }
}

/* -------------------------------------------------------------- */
/* Sections (tabs)                                                 */
/* -------------------------------------------------------------- */

export async function createSectionAction(
  resourceId: string,
  name: string,
): Promise<FinanceResult> {
  await requireAdmin()
  const clean = name.trim().slice(0, MAX_NAME)
  if (!resourceId) return { ok: false, message: 'Ресурс не найден.' }
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
/* Entries                                                         */
/* -------------------------------------------------------------- */

export async function createEntryAction(
  sectionId: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!sectionId) return { ok: false, message: 'Вкладка не найдена.' }

  const title = String(formData.get('title') ?? '').trim().slice(0, MAX_TITLE)
  const type = parseType(String(formData.get('type') ?? 'expense'))
  const status = parseStatus(String(formData.get('status') ?? 'planned'))
  const notes = String(formData.get('notes') ?? '').trim().slice(0, MAX_NOTES)
  const entryDate = parseDate(String(formData.get('entryDate') ?? ''))
  const amount = parseAmount(String(formData.get('amount') ?? '0'))

  if (!title) return { ok: false, message: 'Укажите название записи.' }
  if (Number.isNaN(amount)) {
    return { ok: false, message: 'Введите корректную сумму (не меньше 0).' }
  }

  await createFinanceEntry({
    sectionId,
    title,
    type,
    amount,
    status,
    notes,
    entryDate,
  })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Запись добавлена.' }
}

export async function updateEntryAction(
  id: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись не найдена.' }

  const title = String(formData.get('title') ?? '').trim().slice(0, MAX_TITLE)
  const type = parseType(String(formData.get('type') ?? 'expense'))
  const status = parseStatus(String(formData.get('status') ?? 'planned'))
  const notes = String(formData.get('notes') ?? '').trim().slice(0, MAX_NOTES)
  const entryDate = parseDate(String(formData.get('entryDate') ?? ''))
  const amount = parseAmount(String(formData.get('amount') ?? '0'))

  if (!title) return { ok: false, message: 'Укажите название записи.' }
  if (Number.isNaN(amount)) {
    return { ok: false, message: 'Введите корректную сумму (не меньше 0).' }
  }

  await updateFinanceEntry(id, {
    title,
    type,
    amount,
    status,
    notes,
    entryDate,
  })
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Запись обновлена.' }
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
  return { ok: true, message: 'Запись удалена.' }
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
