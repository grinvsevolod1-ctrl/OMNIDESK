import { decrypt } from '../crypto'
import {
  AD_PLATFORMS,
  AD_STATUSES,
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  VAULT_CATEGORIES,
  type AdMetricKey,
  type AdOverride,
  type AdPlatform,
  type AdStatus,
  type FinanceAdAccount,
  type FinanceAdStat,
  type FinanceAdSyncStat,
  type FinanceAdTopup,
  type FinanceCurrency,
  type FinanceEntry,
  type FinanceEntryStatus,
  type FinanceResource,
  type FinanceSection,
  type FinanceTask,
  type VaultCategory,
  type VaultField,
  type VaultItem,
} from '../finance-types'

/**
 * Internal row shapes + normalizers + mappers for the finance data layer,
 * extracted from lib/finance.ts. These translate raw SQL rows into the domain
 * types and are shared by every finance query module (read/resources/
 * ad-accounts/vault). Pure functions — no DB access beyond decrypting stored
 * secret envelopes.
 */

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

export interface ResourceRow {
  id: string
  name: string
  description: string
  currency: string
  archived: boolean
  created_at: string | Date
}

export interface SectionRow {
  id: string
  resource_id: string
  name: string
  sort_order: number
  created_at: string | Date
}

export interface EntryRow {
  id: string
  section_id: string
  resource_id: string
  title: string
  vendor: string | null
  amount: string | number
  orig_amount: string | number
  orig_currency: string
  fx_rate: string | number
  status: string
  notes: string
  entry_date: string | Date
  due_date: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

export interface TaskRow {
  id: string
  entry_id: string
  label: string
  done: boolean
  sort_order: number
}

export interface AdAccountRow {
  id: string
  resource_id: string
  name: string
  platform: string
  status: string
  account_ref: string
  currency: string
  note: string
  created_at: string | Date
  updated_at: string | Date
  external_enabled: boolean
  yandex_login: string
  yandex_token_enc: string | null
  last_sync_at: string | Date | null
  sync_error: string
}

export interface AdSyncStatRow {
  account_id: string
  period_start: string | Date
  period_end: string | Date
  impressions: string | number
  clicks: string | number
  leads: string | number
  spend: string | number
  synced_at: string | Date
}

export interface AdOverrideRow {
  account_id: string
  metric: string
  value: string | number
  baseline: string | number
  updated_at: string | Date
}

export interface AdTopupRow {
  id: string
  account_id: string
  amount: string | number
  topup_date: string | Date
  note: string
  created_at: string | Date
}

export interface AdStatRow {
  id: string
  account_id: string
  period_start: string | Date
  period_end: string | Date
  impressions: string | number
  clicks: string | number
  leads: string | number
  spend: string | number
  note: string
  created_at: string | Date
}

export interface VaultItemRow {
  id: string
  resource_id: string
  category: string
  title: string
  login: string
  secret_enc: string | null
  url: string
  extra_enc: string | null
  note: string
  tags: string[] | null
  favorite: boolean
  sort_order: number
  created_at: string | Date
  updated_at: string | Date
}

/* ------------------------------------------------------------------ */
/* Normalizers + mappers                                               */
/* ------------------------------------------------------------------ */

export function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

export function dateOnly(value: string | Date | null): string | null {
  if (value == null) return null
  return iso(value).slice(0, 10)
}

export function normCurrency(value: string): FinanceCurrency {
  return FINANCE_CURRENCIES.includes(value as FinanceCurrency)
    ? (value as FinanceCurrency)
    : 'USDT'
}

export function normStatus(value: string): FinanceEntryStatus {
  return FINANCE_ENTRY_STATUSES.includes(value as FinanceEntryStatus)
    ? (value as FinanceEntryStatus)
    : 'planned'
}

export function normPlatform(value: string): AdPlatform {
  return AD_PLATFORMS.includes(value as AdPlatform)
    ? (value as AdPlatform)
    : 'other'
}

export function normAdStatus(value: string): AdStatus {
  return AD_STATUSES.includes(value as AdStatus)
    ? (value as AdStatus)
    : 'active'
}

export function normVaultCategory(value: string): VaultCategory {
  return VAULT_CATEGORIES.includes(value as VaultCategory)
    ? (value as VaultCategory)
    : 'other'
}

/** Decrypt a stored envelope, tolerating a rotated/missing key (returns ''). */
export function safeDecrypt(envelope: string | null): string {
  if (!envelope) return ''
  try {
    return decrypt(envelope)
  } catch {
    // Key rotated or ciphertext tampered — never crash the whole page.
    return ''
  }
}

export function normVaultFields(raw: string): VaultField[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({
        label: String((f as VaultField).label ?? ''),
        value: String((f as VaultField).value ?? ''),
        secret: Boolean((f as VaultField).secret),
      }))
  } catch {
    return []
  }
}

export function mapVaultItem(row: VaultItemRow): VaultItem {
  return {
    id: row.id,
    resourceId: row.resource_id,
    category: normVaultCategory(row.category),
    title: row.title,
    login: row.login ?? '',
    secret: safeDecrypt(row.secret_enc),
    url: row.url ?? '',
    fields: normVaultFields(safeDecrypt(row.extra_enc)),
    note: row.note ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    favorite: row.favorite,
    sortOrder: row.sort_order,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapResource(row: ResourceRow): FinanceResource {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    currency: normCurrency(row.currency),
    archived: row.archived,
    createdAt: iso(row.created_at),
  }
}

export function mapSection(row: SectionRow): FinanceSection {
  return {
    id: row.id,
    resourceId: row.resource_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: iso(row.created_at),
  }
}

export function mapTask(row: TaskRow): FinanceTask {
  return {
    id: row.id,
    entryId: row.entry_id,
    label: row.label,
    done: row.done,
    sortOrder: row.sort_order,
  }
}

export function mapEntry(row: EntryRow, tasks: FinanceTask[]): FinanceEntry {
  return {
    id: row.id,
    sectionId: row.section_id,
    resourceId: row.resource_id,
    title: row.title,
    vendor: row.vendor ?? '',
    amount: Number(row.amount) || 0,
    origAmount: Number(row.orig_amount) || 0,
    origCurrency: normCurrency(row.orig_currency),
    fxRate: Number(row.fx_rate) || 1,
    status: normStatus(row.status),
    notes: row.notes ?? '',
    entryDate: iso(row.entry_date).slice(0, 10),
    dueDate: dateOnly(row.due_date),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    tasks,
  }
}

export function mapTopup(row: AdTopupRow): FinanceAdTopup {
  return {
    id: row.id,
    accountId: row.account_id,
    amount: Number(row.amount) || 0,
    topupDate: iso(row.topup_date).slice(0, 10),
    note: row.note ?? '',
    createdAt: iso(row.created_at),
  }
}

export function mapStat(row: AdStatRow): FinanceAdStat {
  return {
    id: row.id,
    accountId: row.account_id,
    periodStart: iso(row.period_start).slice(0, 10),
    periodEnd: iso(row.period_end).slice(0, 10),
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    leads: Number(row.leads) || 0,
    spend: Number(row.spend) || 0,
    note: row.note ?? '',
    createdAt: iso(row.created_at),
  }
}

export function mapSyncStat(row: AdSyncStatRow): FinanceAdSyncStat {
  return {
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    leads: Number(row.leads) || 0,
    spend: Number(row.spend) || 0,
    periodStart: iso(row.period_start).slice(0, 10),
    periodEnd: iso(row.period_end).slice(0, 10),
    syncedAt: iso(row.synced_at),
  }
}

export function mapAdAccount(
  row: AdAccountRow,
  topups: FinanceAdTopup[],
  stats: FinanceAdStat[],
  syncStat: FinanceAdSyncStat | null,
  overrides: Partial<Record<AdMetricKey, AdOverride>>,
): FinanceAdAccount {
  return {
    id: row.id,
    resourceId: row.resource_id,
    name: row.name,
    platform: normPlatform(row.platform),
    status: normAdStatus(row.status),
    accountRef: row.account_ref ?? '',
    currency: normCurrency(row.currency),
    note: row.note ?? '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    topups,
    stats,
    externalEnabled: Boolean(row.external_enabled),
    yandexLogin: row.yandex_login ?? '',
    hasToken: Boolean(row.yandex_token_enc),
    lastSyncAt: row.last_sync_at ? iso(row.last_sync_at) : null,
    syncError: row.sync_error ?? '',
    syncStat,
    overrides,
  }
}
