'use client'

/**
 * Shared, side-effect-free helpers for the finance admin area: display metadata,
 * currency/number formatters, the USD-rates context, and the pure ad-account
 * aggregation math. Extracted from the (very large) finance-admin.tsx so the
 * overview/ads/expenses/vault panels can all import one source of truth instead
 * of the monolith re-declaring it. Everything here is pure or a plain context —
 * no data fetching, no server actions — which is what makes the split safe.
 */

import { createContext, useContext } from 'react'
import {
  AtSign,
  CreditCard,
  Database,
  FileText,
  Globe,
  KeyRound,
  Mail,
  Server,
  TerminalSquare,
  User,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DEFAULT_USD_RATES,
  adEffectiveMetrics,
  toUsd,
  type UsdRates,
  type AdPlatform,
  type AdStatus,
  type FinanceAdAccount,
  type FinanceCurrency,
  type FinanceEntryStatus,
  type VaultCategory,
} from '@/lib/finance-types'

/* ================================================================== */
/* Meta                                                                */
/* ================================================================== */

export const STATUS_META: Record<
  FinanceEntryStatus,
  { label: string; className: string }
> = {
  planned: { label: 'Запланирован', className: 'bg-muted text-muted-foreground' },
  in_progress: { label: 'В работе', className: 'bg-warning/15 text-warning' },
  done: { label: 'Оплачен', className: 'bg-success/15 text-success' },
  cancelled: {
    label: 'Отменён',
    className: 'bg-destructive/10 text-destructive',
  },
}

export const PLATFORM_META: Record<AdPlatform, string> = {
  yandex_direct: 'Яндекс Директ',
  google_ads: 'Google Ads',
  vk_ads: 'VK Реклама',
  telegram_ads: 'Telegram Ads',
  mytarget: 'myTarget',
  other: 'Другое',
}

export const AD_STATUS_META: Record<
  AdStatus,
  { label: string; className: string; dot: string }
> = {
  active: {
    label: 'Активен',
    className: 'bg-success/15 text-success',
    dot: 'bg-success',
  },
  moderation: {
    label: 'На модерации',
    className: 'bg-warning/15 text-warning',
    dot: 'bg-warning',
  },
  stopped: {
    label: 'Остановлен',
    className: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
  no_funds: {
    label: 'Нет средств',
    className: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
  },
  banned: {
    label: 'Забанен',
    className: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
  },
  archived: {
    label: 'Архив',
    className: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
}

export const VAULT_CATEGORY_META: Record<
  VaultCategory,
  { label: string; icon: typeof KeyRound; tint: string }
> = {
  credential: {
    label: 'Учётная запись',
    icon: KeyRound,
    tint: 'bg-primary/10 text-primary',
  },
  server: { label: 'Сервер', icon: Server, tint: 'bg-success/15 text-success' },
  account: { label: 'Аккаунт', icon: User, tint: 'bg-primary/10 text-primary' },
  social: {
    label: 'Соцсеть / ник',
    icon: AtSign,
    tint: 'bg-warning/15 text-warning',
  },
  payment: {
    label: 'Счёт / оплата',
    icon: CreditCard,
    tint: 'bg-success/15 text-success',
  },
  email: { label: 'Почта', icon: Mail, tint: 'bg-primary/10 text-primary' },
  domain: { label: 'Домен', icon: Globe, tint: 'bg-warning/15 text-warning' },
  api_key: {
    label: 'API-ключ',
    icon: TerminalSquare,
    tint: 'bg-destructive/10 text-destructive',
  },
  database: {
    label: 'База данных',
    icon: Database,
    tint: 'bg-success/15 text-success',
  },
  other: {
    label: 'Другое',
    icon: FileText,
    tint: 'bg-muted text-muted-foreground',
  },
}

/* ================================================================== */
/* Clipboard + password                                                */
/* ================================================================== */

export async function copyToClipboard(
  value: string,
  label: string,
): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    toast.success(`${label} скопирован${label.endsWith('а') ? 'а' : ''}`)
  } catch {
    toast.error('Не удалось скопировать')
  }
}

/** Cryptographically strong password for the generator button. */
export function generatePassword(length = 20): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+'
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[arr[i] % alphabet.length]
  return out
}

/* ================================================================== */
/* Formatters                                                          */
/* ================================================================== */

export const CURRENCY_SYMBOL: Record<FinanceCurrency, string> = {
  USDT: '₮',
  RUB: '₽',
  USD: '$',
  EUR: '€',
}

export function formatMoney(amount: number, currency: FinanceCurrency): string {
  const n = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
  return `${n} ${CURRENCY_SYMBOL[currency]}`
}

/* ------------------------------------------------------------------ */
/* Единая валюта отображения — USD                                    */
/* ------------------------------------------------------------------ */

/** Курсы (USD за 1 единицу валюты) на текущий рендер. */
export const RatesContext = createContext<UsdRates>(DEFAULT_USD_RATES)

export function useRates(): UsdRates {
  return useContext(RatesContext)
}

/** Отформатировать сумму в USD. */
export function formatUsd(amount: number): string {
  const n = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
  return `${n} $`
}

export function formatInt(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(n)
}

export function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(n < 10 ? 2 : 1)}%`
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d)
}

/** Дата и время для полного ISO-таймстампа (например, момент синхронизации). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

/* ================================================================== */
/* Aggregation                                                         */
/* ================================================================== */

export interface AccountMetrics {
  topups: number
  spend: number
  balance: number
  impressions: number
  clicks: number
  leads: number
  ctr: number
  cr: number
  cpl: number
  cpc: number
}

/**
 * Метрики кабинета в USD. Пополнения и расход хранятся в валюте кабинета
 * (`a.currency`) и приводятся к USD по текущему курсу `rates`.
 */
export function accountMetrics(
  a: FinanceAdAccount,
  rates: UsdRates,
): AccountMetrics {
  const topupsNative = a.topups.reduce((s, t) => s + t.amount, 0)
  // Метрики берём из единого источника: данные Яндекса (если интеграция включена)
  // или сумма ручных снимков, поверх которых применяются корректировки god-страницы.
  const {
    impressions,
    clicks,
    leads,
    spend: spendNative,
  } = adEffectiveMetrics(a)
  const topups = toUsd(topupsNative, a.currency, rates)
  const spend = toUsd(spendNative, a.currency, rates)
  return {
    topups,
    spend,
    balance: topups - spend,
    impressions,
    clicks,
    leads,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cr: clicks > 0 ? (leads / clicks) * 100 : 0,
    cpl: leads > 0 ? spend / leads : Number.POSITIVE_INFINITY,
    cpc: clicks > 0 ? spend / clicks : Number.POSITIVE_INFINITY,
  }
}

/** Итог по кабинетам в USD (единая валюта отображения). */
export interface UsdTotals {
  topups: number
  spend: number
  balance: number
  leads: number
}

export interface ResourceAdSummary {
  leads: number
  clicks: number
  impressions: number
  ctr: number
  cr: number
  activeAccounts: number
  totalAccounts: number
  totals: UsdTotals
  lowBalance: FinanceAdAccount[]
}

export function summarizeAds(
  accounts: FinanceAdAccount[],
  rates: UsdRates,
): ResourceAdSummary {
  let leads = 0
  let clicks = 0
  let impressions = 0
  let activeAccounts = 0
  const totals: UsdTotals = { topups: 0, spend: 0, balance: 0, leads: 0 }
  const lowBalance: FinanceAdAccount[] = []

  for (const a of accounts) {
    const m = accountMetrics(a, rates)
    leads += m.leads
    clicks += m.clicks
    impressions += m.impressions
    if (a.status === 'active') activeAccounts += 1

    totals.topups += m.topups
    totals.spend += m.spend
    totals.balance += m.balance
    totals.leads += m.leads

    if (a.status !== 'archived' && m.balance <= 0 && m.topups > 0) {
      lowBalance.push(a)
    }
  }

  return {
    leads,
    clicks,
    impressions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cr: clicks > 0 ? (leads / clicks) * 100 : 0,
    activeAccounts,
    totalAccounts: accounts.length,
    totals,
    lowBalance,
  }
}
