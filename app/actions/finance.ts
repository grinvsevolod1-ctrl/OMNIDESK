'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  addFinanceAdStat,
  addFinanceAdTopup,
  addFinanceTask,
  createFinanceAdAccount,
  createFinanceEntry,
  createFinanceResource,
  createFinanceSection,
  createFinanceVaultItem,
  deleteFinanceAdAccount,
  deleteFinanceAdStat,
  deleteFinanceAdTopup,
  deleteFinanceEntry,
  deleteFinanceResource,
  deleteFinanceSection,
  deleteFinanceTask,
  deleteFinanceVaultItem,
  moveFinanceEntry,
  renameFinanceSection,
  setFinanceTaskDone,
  setFinanceVaultFavorite,
  updateFinanceAdAccount,
  updateFinanceEntry,
  updateFinanceResource,
  updateFinanceVaultItem,
  AD_PLATFORMS,
  AD_STATUSES,
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  VAULT_CATEGORIES,
  type AdPlatform,
  type AdStatus,
  type FinanceCurrency,
  type FinanceEntryStatus,
  type VaultCategory,
  type VaultField,
} from '@/lib/finance'
import { toUsd, usdRateFor } from '@/lib/finance-types'
import { getUsdRates } from '@/lib/fx'
import { syncAdAccount } from '@/lib/ads-yandex'

export interface FinanceResult {
  ok: boolean
  message: string
}

const MAX_NAME = 120
const MAX_TITLE = 200
const MAX_NOTES = 4000
const MAX_LABEL = 300
const MAX_REF = 200

/* -------------------------------------------------------------- */
/* Parsers                                                         */
/* -------------------------------------------------------------- */

function parseCurrency(raw: string): FinanceCurrency {
  return FINANCE_CURRENCIES.includes(raw as FinanceCurrency)
    ? (raw as FinanceCurrency)
    : 'USDT'
}

function parseStatus(raw: string): FinanceEntryStatus {
  return FINANCE_ENTRY_STATUSES.includes(raw as FinanceEntryStatus)
    ? (raw as FinanceEntryStatus)
    : 'planned'
}

function parsePlatform(raw: string): AdPlatform {
  return AD_PLATFORMS.includes(raw as AdPlatform)
    ? (raw as AdPlatform)
    : 'other'
}

function parseAdStatus(raw: string): AdStatus {
  return AD_STATUSES.includes(raw as AdStatus)
    ? (raw as AdStatus)
    : 'active'
}

function parseVaultCategory(raw: string): VaultCategory {
  return VAULT_CATEGORIES.includes(raw as VaultCategory)
    ? (raw as VaultCategory)
    : 'credential'
}

/** Comma/newline separated tags -> unique, trimmed, capped list. */
function parseTags(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(/[,\n]/)) {
    const tag = part.trim().slice(0, 40)
    if (tag) seen.add(tag)
    if (seen.size >= 20) break
  }
  return [...seen]
}

/** Parse the custom-fields JSON blob from the dialog, defensively. */
function parseVaultFields(raw: string): VaultField[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const fields: VaultField[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const label = String(f.label ?? '').trim().slice(0, MAX_NAME)
    const value = String(f.value ?? '').slice(0, MAX_NOTES)
    if (!label && !value) continue
    fields.push({ label, value, secret: Boolean(f.secret) })
    if (fields.length >= 40) break
  }
  return fields
}

function parseAmount(raw: string): number {
  // Accept comma decimals ("1 200,50") and stray spaces.
  const normalized = raw.replace(/\s+/g, '').replace(',', '.')
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return Number.NaN
  return Math.round(value * 100) / 100
}

function parseCount(raw: string): number {
  const normalized = raw.replace(/\s+/g, '')
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return Number.NaN
  return Math.floor(value)
}

function parseDate(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : new Date().toISOString().slice(0, 10)
}

function parseOptionalDate(raw: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
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
  // Валюта источника не назначается вручную — все суммы ведутся в USD.
  const currency: FinanceCurrency = 'USD'

  if (!name) return { ok: false, message: 'Укажите название источника.' }

  await createFinanceResource({ name, description, currency })
  revalidatePath('/admin/finance')
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
  return { ok: true, message: 'Ресурс обновлён.' }
}

export async function deleteResourceAction(
  id: string,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Ресурс не найден.' }
  await deleteFinanceResource(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Ресурс удалён вместе со всеми данными.' }
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

/* -------------------------------------------------------------- */
/* Vault (Хранилище)                                              */
/* -------------------------------------------------------------- */

function readVaultForm(formData: FormData) {
  return {
    category: parseVaultCategory(String(formData.get('category') ?? '')),
    title: String(formData.get('title') ?? '').trim().slice(0, MAX_TITLE),
    login: String(formData.get('login') ?? '').trim().slice(0, MAX_REF),
    secret: String(formData.get('secret') ?? '').slice(0, MAX_NOTES),
    url: String(formData.get('url') ?? '').trim().slice(0, MAX_NOTES),
    fields: parseVaultFields(String(formData.get('fields') ?? '')),
    note: String(formData.get('note') ?? '').trim().slice(0, MAX_NOTES),
    tags: parseTags(String(formData.get('tags') ?? '')),
    favorite: String(formData.get('favorite') ?? '') === 'true',
  }
}

export async function createVaultItemAction(
  resourceId: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!resourceId) return { ok: false, message: 'Ресурс не найден.' }
  const input = readVaultForm(formData)
  if (!input.title) return { ok: false, message: 'Укажите название записи.' }
  try {
    await createFinanceVaultItem(resourceId, input)
  } catch {
    return {
      ok: false,
      message:
        'Не удалось зашифровать секрет. Задайте ENCRYPTION_KEY (openssl rand -hex 32).',
    }
  }
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Запись добавлена в хранилище.' }
}

export async function updateVaultItemAction(
  id: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись не найдена.' }
  const input = readVaultForm(formData)
  if (!input.title) return { ok: false, message: 'Укажите название записи.' }
  try {
    await updateFinanceVaultItem(id, input)
  } catch {
    return {
      ok: false,
      message:
        'Не удалось зашифровать секрет. Задайте ENCRYPTION_KEY (openssl rand -hex 32).',
    }
  }
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Запись обновлена.' }
}

export async function toggleVaultFavoriteAction(
  id: string,
  favorite: boolean,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись не найдена.' }
  await setFinanceVaultFavorite(id, favorite)
  revalidatePath('/admin/finance')
  return { ok: true, message: favorite ? 'Закреплено.' : 'Откреплено.' }
}

export async function deleteVaultItemAction(
  id: string,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись не найдена.' }
  await deleteFinanceVaultItem(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Запись удалена из хранилища.' }
}

interface VaultImportRow {
  category?: string
  title?: string
  login?: string
  secret?: string
  url?: string
  note?: string
  tags?: string[]
  favorite?: boolean
  fields?: VaultField[]
}

export async function importVaultItemsAction(
  resourceId: string,
  rows: VaultImportRow[],
): Promise<FinanceResult> {
  await requireAdmin()
  if (!resourceId) return { ok: false, message: 'Ресурс не найден.' }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, message: 'Нет записей для импорта.' }
  }
  if (rows.length > 500) {
    return { ok: false, message: 'За один раз можно импортировать до 500 записей.' }
  }

  let imported = 0
  try {
    for (const raw of rows) {
      const title = String(raw.title ?? '').trim().slice(0, MAX_TITLE)
      if (!title) continue
      const fields: VaultField[] = Array.isArray(raw.fields)
        ? raw.fields
            .filter((f) => f && typeof f === 'object')
            .map((f) => ({
              label: String(f.label ?? '').trim().slice(0, MAX_NAME),
              value: String(f.value ?? '').slice(0, MAX_NOTES),
              secret: Boolean(f.secret),
            }))
            .filter((f) => f.label || f.value)
            .slice(0, 40)
        : []
      await createFinanceVaultItem(resourceId, {
        category: parseVaultCategory(String(raw.category ?? '')),
        title,
        login: String(raw.login ?? '').trim().slice(0, MAX_REF),
        secret: String(raw.secret ?? '').slice(0, MAX_NOTES),
        url: String(raw.url ?? '').trim().slice(0, MAX_NOTES),
        fields,
        note: String(raw.note ?? '').trim().slice(0, MAX_NOTES),
        tags: Array.isArray(raw.tags)
          ? raw.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20)
          : [],
        favorite: raw.favorite === true,
      })
      imported += 1
    }
  } catch {
    return {
      ok: false,
      message:
        'Импорт прерван. Проверьте, что задан ENCRYPTION_KEY для шифрования секретов.',
    }
  }

  revalidatePath('/admin/finance')
  return {
    ok: imported > 0,
    message: imported > 0 ? `Импортировано записей: ${imported}.` : 'Подходящих записей не найдено.',
  }
}
