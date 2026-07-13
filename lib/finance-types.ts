/**
 * Shared finance types + enum arrays.
 *
 * Kept free of any server-only imports (no `pg`, no `./db`) so it can be
 * imported from client components as well as server code.
 */

export type FinanceCurrency = 'USDT' | 'RUB' | 'USD' | 'EUR'

/* ------------------------------------------------------------------ */
/* Конвертация валют в USD                                             */
/* ------------------------------------------------------------------ */

/**
 * Курс: сколько USD стоит 1 единица валюты.
 * Пример: RUB → 0.011 значит 1 ₽ ≈ 0.011 $.
 * USD и USDT всегда 1.
 */
export type UsdRates = Record<FinanceCurrency, number>

/** Резервные курсы на случай, если внешний API недоступен. */
export const DEFAULT_USD_RATES: UsdRates = {
  USD: 1,
  USDT: 1,
  RUB: 0.011,
  EUR: 1.08,
}

/** Перевести сумму `amount` из валюты `currency` в USD по курсам `rates`. */
export function toUsd(
  amount: number,
  currency: FinanceCurrency,
  rates: UsdRates,
): number {
  const rate = rates[currency] ?? 1
  return Math.round(amount * rate * 100) / 100
}

/** Курс (USD за 1 единицу валюты), который замораживаем в записи. */
export function usdRateFor(currency: FinanceCurrency, rates: UsdRates): number {
  return rates[currency] ?? 1
}
export type FinanceEntryStatus =
  | 'planned'
  | 'in_progress'
  | 'done'
  | 'cancelled'

export type AdPlatform =
  | 'yandex_direct'
  | 'google_ads'
  | 'vk_ads'
  | 'telegram_ads'
  | 'mytarget'
  | 'other'

export type AdStatus =
  | 'active'
  | 'moderation'
  | 'stopped'
  | 'no_funds'
  | 'banned'
  | 'archived'

export const FINANCE_CURRENCIES: FinanceCurrency[] = [
  'USDT',
  'RUB',
  'USD',
  'EUR',
]
export const FINANCE_ENTRY_STATUSES: FinanceEntryStatus[] = [
  'planned',
  'in_progress',
  'done',
  'cancelled',
]
export const AD_PLATFORMS: AdPlatform[] = [
  'yandex_direct',
  'google_ads',
  'vk_ads',
  'telegram_ads',
  'mytarget',
  'other',
]
export const AD_STATUSES: AdStatus[] = [
  'active',
  'moderation',
  'stopped',
  'no_funds',
  'banned',
  'archived',
]

/* ------------------------------------------------------------------ */
/* Vault (Хранилище)                                                   */
/* ------------------------------------------------------------------ */

export type VaultCategory =
  | 'credential'
  | 'server'
  | 'account'
  | 'social'
  | 'payment'
  | 'email'
  | 'domain'
  | 'api_key'
  | 'database'
  | 'other'

export const VAULT_CATEGORIES: VaultCategory[] = [
  'credential',
  'server',
  'account',
  'social',
  'payment',
  'email',
  'domain',
  'api_key',
  'database',
  'other',
]

/** Произвольное доп. поле записи хранилища. */
export interface VaultField {
  label: string
  value: string
  /** Скрывать значение под точками с кнопкой «показать». */
  secret: boolean
}

export interface VaultItem {
  id: string
  resourceId: string
  category: VaultCategory
  title: string
  /** Открытая часть: логин / e-mail / ник / номер счёта. */
  login: string
  /** Расшифрованный основной секрет (пароль/токен). '' если нет. */
  secret: string
  url: string
  /** Расшифрованные доп. поля. */
  fields: VaultField[]
  note: string
  tags: string[]
  favorite: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface FinanceTask {
  id: string
  entryId: string
  label: string
  done: boolean
  sortOrder: number
}

export interface FinanceEntry {
  id: string
  sectionId: string
  resourceId: string
  title: string
  vendor: string
  /** Сумма в USD (заморожена по курсу на момент добавления). */
  amount: number
  /** Исходная сумма в валюте ввода. */
  origAmount: number
  /** Валюта, в которой вводили сумму. */
  origCurrency: FinanceCurrency
  /** Курс (USD за 1 единицу origCurrency) на момент добавления. */
  fxRate: number
  status: FinanceEntryStatus
  notes: string
  entryDate: string
  dueDate: string | null
  createdAt: string
  updatedAt: string
  tasks: FinanceTask[]
}

export interface FinanceSection {
  id: string
  resourceId: string
  name: string
  sortOrder: number
  createdAt: string
}

export interface FinanceResource {
  id: string
  name: string
  description: string
  currency: FinanceCurrency
  archived: boolean
  createdAt: string
}

export interface FinanceAdTopup {
  id: string
  accountId: string
  amount: number
  topupDate: string
  note: string
  createdAt: string
}

export interface FinanceAdStat {
  id: string
  accountId: string
  periodStart: string
  periodEnd: string
  impressions: number
  clicks: number
  leads: number
  spend: number
  note: string
  createdAt: string
}

/* ------------------------------------------------------------------ */
/* Интеграция с рекламной площадкой + ручные корректировки             */
/* ------------------------------------------------------------------ */

/** Метрики кабинета, которыми можно управлять с god-страницы. */
export type AdMetricKey = 'impressions' | 'clicks' | 'leads' | 'spend'

export const AD_METRIC_KEYS: AdMetricKey[] = [
  'impressions',
  'clicks',
  'leads',
  'spend',
]

export const AD_METRIC_LABELS: Record<AdMetricKey, string> = {
  impressions: 'Показы',
  clicks: 'Клики',
  leads: 'Лиды',
  spend: 'Расход',
}

/**
 * Ручная корректировка метрики (god-страница).
 * value    — зафиксированное админом значение («моя база»);
 * baseline — значение из Яндекса на момент фиксации.
 * Итог = value + max(0, Яндекс_текущий − baseline).
 */
export interface AdOverride {
  value: number
  baseline: number
  updatedAt: string
}

/** Последний снимок «сырых» метрик из Яндекс.Директа. */
export interface FinanceAdSyncStat {
  impressions: number
  clicks: number
  leads: number
  spend: number
  periodStart: string
  periodEnd: string
  syncedAt: string
}

export interface FinanceAdAccount {
  id: string
  resourceId: string
  name: string
  platform: AdPlatform
  status: AdStatus
  accountRef: string
  currency: FinanceCurrency
  note: string
  createdAt: string
  updatedAt: string
  topups: FinanceAdTopup[]
  stats: FinanceAdStat[]
  /* Интеграция с Яндекс.Директом */
  externalEnabled: boolean
  yandexLogin: string
  /** true, если OAuth-токен сохранён (само значение наружу не отдаём). */
  hasToken: boolean
  lastSyncAt: string | null
  syncError: string
  syncStat: FinanceAdSyncStat | null
  /* Ручные корректировки метрик (god-страница) */
  overrides: Partial<Record<AdMetricKey, AdOverride>>
}

/**
 * «Сырые» метрики кабинета до корректировок: из Яндекса, если интеграция
 * включена и есть снимок, иначе — сумма ручных снимков статистики.
 */
export function adBaseMetrics(a: FinanceAdAccount): Record<AdMetricKey, number> {
  if (a.externalEnabled && a.syncStat) {
    return {
      impressions: a.syncStat.impressions,
      clicks: a.syncStat.clicks,
      leads: a.syncStat.leads,
      spend: a.syncStat.spend,
    }
  }
  let impressions = 0
  let clicks = 0
  let leads = 0
  let spend = 0
  for (const s of a.stats) {
    impressions += s.impressions
    clicks += s.clicks
    leads += s.leads
    spend += s.spend
  }
  return { impressions, clicks, leads, spend }
}

/**
 * Итоговые метрики с учётом ручных корректировок:
 * если по метрике задан override — показываем «мою базу» плюс прирост Яндекса
 * относительно зафиксированного baseline (новые данные приплюсовываются).
 */
export function adEffectiveMetrics(
  a: FinanceAdAccount,
): Record<AdMetricKey, number> {
  const base = adBaseMetrics(a)
  const out = { ...base }
  for (const key of AD_METRIC_KEYS) {
    const ov = a.overrides[key]
    if (ov) out[key] = ov.value + Math.max(0, base[key] - ov.baseline)
  }
  return out
}

export interface FinanceData {
  resources: FinanceResource[]
  sections: FinanceSection[]
  entries: FinanceEntry[]
  adAccounts: FinanceAdAccount[]
  vaultItems: VaultItem[]
  /** true, если ENCRYPTION_KEY задан и секреты хранилища шифруются. */
  encryptionReady: boolean
}
