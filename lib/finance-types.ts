/**
 * Shared finance types + enum arrays.
 *
 * Kept free of any server-only imports (no `pg`, no `./db`) so it can be
 * imported from client components as well as server code.
 */

export type FinanceCurrency = 'USDT' | 'RUB' | 'USD' | 'EUR'
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
  amount: number
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
