/**
 * Общие типы, лимиты и парсеры форм для finance-actions.
 * НЕ 'use server' — здесь нет server actions, только чистые хелперы.
 */
import {
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

export interface FinanceResult {
  ok: boolean
  message: string
}

export const MAX_NAME = 120
export const MAX_TITLE = 200
export const MAX_NOTES = 4000
export const MAX_LABEL = 300
export const MAX_REF = 200

export function parseCurrency(raw: string): FinanceCurrency {
  return FINANCE_CURRENCIES.includes(raw as FinanceCurrency)
    ? (raw as FinanceCurrency)
    : 'USDT'
}

export function parseStatus(raw: string): FinanceEntryStatus {
  return FINANCE_ENTRY_STATUSES.includes(raw as FinanceEntryStatus)
    ? (raw as FinanceEntryStatus)
    : 'planned'
}

export function parsePlatform(raw: string): AdPlatform {
  return AD_PLATFORMS.includes(raw as AdPlatform)
    ? (raw as AdPlatform)
    : 'other'
}

export function parseAdStatus(raw: string): AdStatus {
  return AD_STATUSES.includes(raw as AdStatus)
    ? (raw as AdStatus)
    : 'active'
}

export function parseVaultCategory(raw: string): VaultCategory {
  return VAULT_CATEGORIES.includes(raw as VaultCategory)
    ? (raw as VaultCategory)
    : 'credential'
}

/** Comma/newline separated tags -> unique, trimmed, capped list. */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(/[,\n]/)) {
    const tag = part.trim().slice(0, 40)
    if (tag) seen.add(tag)
    if (seen.size >= 20) break
  }
  return [...seen]
}

/** Parse the custom-fields JSON blob from the dialog, defensively. */
export function parseVaultFields(raw: string): VaultField[] {
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

export function parseAmount(raw: string): number {
  // Accept comma decimals ("1 200,50") and stray spaces.
  const normalized = raw.replace(/\s+/g, '').replace(',', '.')
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return Number.NaN
  return Math.round(value * 100) / 100
}

export function parseCount(raw: string): number {
  const normalized = raw.replace(/\s+/g, '')
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return Number.NaN
  return Math.floor(value)
}

export function parseDate(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : new Date().toISOString().slice(0, 10)
}

export function parseOptionalDate(raw: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}
