'use server'

import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  GmtApiError,
  gmtBulkStatus,
  gmtCountries,
  gmtCountryDetails,
  gmtCreateBulkPurchase,
  gmtCreatePurchase,
  gmtHealth,
  gmtProfile,
  gmtPurchaseDetails,
  gmtPurchases,
  gmtRefund,
  gmtRequestCode,
  clearGmtApiKey,
  getGmtKeyInfo,
  isGmtConfigured,
  setGmtApiKey,
  type GmtBulkPurchase,
  type GmtCodeRequest,
  type GmtCountry,
  type GmtCountryDetails,
  type GmtPagination,
  type GmtProfile,
  type GmtPurchase,
  type GmtPurchaseStatus,
} from '@/lib/god-gmt'

/* ===================================================================== */
/*  Get My TG — god-панель, вкладка «API TG»                              */
/* ===================================================================== */

// Type-only реэкспорт для клиентской вкладки (стирается при компиляции,
// 'use server'-ограничение на экспорты функций не нарушает — тот же
// паттерн, что SiteListItem в sites.ts).
export type {
  GmtBulkPurchase,
  GmtCodeRequest,
  GmtCountry,
  GmtCountryDetails,
  GmtMoney,
  GmtPagination,
  GmtProfile,
  GmtPurchase,
  GmtPurchaseStatus,
} from '@/lib/god-gmt'

/**
 * Гейт: admin-сессия И god-разблокировка (та же форма, что у sites.ts и
 * telegram-personal.ts). Заблокированный гейт отвечает 404.
 *
 * Сознательно НЕТ audit()-вызовов: admin-видимый журнал не должен нести
 * следов этого модуля (СВЯЩЕННЫЙ ИНВАРИАНТ, AGENTS.md §4).
 */
async function requireGod(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) notFound()
}

export interface GmtActionResult<T> {
  ok: boolean
  message: string
  data?: T
}

/** Единая обёртка: гейт → вызов → человекочитаемая ошибка (без утечки ключа). */
async function runGmt<T>(fn: () => Promise<T>): Promise<GmtActionResult<T>> {
  await requireGod()
  if (!(await isGmtConfigured())) {
    return {
      ok: false,
      message: 'Ключ Get My TG не настроен. Укажите его во вкладке «API TG».',
    }
  }
  try {
    return { ok: true, message: 'OK', data: await fn() }
  } catch (err) {
    if (err instanceof GmtApiError) {
      return { ok: false, message: `Get My TG: ${err.message}` }
    }
    return { ok: false, message: 'Внутренняя ошибка при обращении к Get My TG' }
  }
}

/** Статус настройки + здоровье сервиса — для шапки вкладки. */
export async function secretGmtStatusAction(): Promise<
  GmtActionResult<{
    configured: boolean
    health: 'ok' | 'degraded' | 'unreachable'
    keySource: 'db' | 'env' | null
    keyMasked: string | null
  }>
> {
  await requireGod()
  const keyInfo = await getGmtKeyInfo()
  if (!keyInfo.source) {
    return {
      ok: true,
      message: 'OK',
      data: {
        configured: false,
        health: 'unreachable',
        keySource: null,
        keyMasked: null,
      },
    }
  }
  try {
    const h = await gmtHealth()
    return {
      ok: true,
      message: 'OK',
      data: {
        configured: true,
        health: h.status,
        keySource: keyInfo.source,
        keyMasked: keyInfo.masked,
      },
    }
  } catch {
    return {
      ok: true,
      message: 'OK',
      data: {
        configured: true,
        health: 'unreachable',
        keySource: keyInfo.source,
        keyMasked: keyInfo.masked,
      },
    }
  }
}

/**
 * Назначить ключ Get My TG из панели (хранится в god_settings, миграция 139).
 * Перед сохранением ключ проверяется живым запросом к профилю — опечатка
 * не затирает рабочий ключ. Как и всё в этом модуле — без audit()-следов.
 */
export async function secretGmtSetKeyAction(
  key: string,
): Promise<GmtActionResult<{ keyMasked: string }>> {
  await requireGod()
  const trimmed = key.trim()
  if (!trimmed || trimmed.length < 8 || trimmed.length > 200) {
    return { ok: false, message: 'Ключ: строка от 8 до 200 символов' }
  }
  // Проверяем ключ ДО сохранения — прямым запросом к API, минуя кэш.
  try {
    const res = await fetch('https://api.getmytg.com/v1/profile/', {
      headers: { 'x-api-key': trimmed },
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Get My TG отверг ключ (401/403) — проверьте его' }
    }
    if (!res.ok) {
      return { ok: false, message: `Get My TG недоступен (HTTP ${res.status}) — попробуйте позже` }
    }
  } catch {
    return { ok: false, message: 'Не удалось проверить ключ: сеть недоступна' }
  }
  await setGmtApiKey(trimmed)
  return {
    ok: true,
    message: 'Ключ сохранён',
    data: { keyMasked: `••••${trimmed.slice(-4)}` },
  }
}

/** Удалить ключ из БД (env-fallback, если задан, продолжит действовать). */
export async function secretGmtClearKeyAction(): Promise<
  GmtActionResult<null>
> {
  await requireGod()
  await clearGmtApiKey()
  return { ok: true, message: 'Ключ удалён из панели', data: null }
}

export async function secretGmtProfileAction(): Promise<
  GmtActionResult<GmtProfile>
> {
  return runGmt(() => gmtProfile())
}

export async function secretGmtCountriesAction(
  sort?: string,
): Promise<GmtActionResult<GmtCountry[]>> {
  return runGmt(async () => {
    const res = await gmtCountries({ sort, pageSize: 150 })
    return res.items
  })
}

export async function secretGmtPurchasesAction(
  status?: GmtPurchaseStatus,
  page?: number,
): Promise<
  GmtActionResult<{ items: GmtPurchase[]; pagination: GmtPagination }>
> {
  const safePage =
    Number.isInteger(page) && (page as number) >= 1 ? (page as number) : 1
  return runGmt(() => gmtPurchases({ status, page: safePage, pageSize: 25 }))
}

/** Разбивка цены со скидкой для диалога подтверждения покупки. */
export async function secretGmtCountryDetailsAction(
  countryCode: string,
): Promise<GmtActionResult<GmtCountryDetails>> {
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { ok: false, message: 'Некорректный код страны' }
  }
  return runGmt(() => gmtCountryDetails(countryCode))
}

/** Оптовая закупка: quantity ограничен 1..100 — защита от опечатки на 4 нуля. */
export async function secretGmtBulkBuyAction(
  countryCode: string,
  quantity: number,
): Promise<GmtActionResult<GmtBulkPurchase>> {
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { ok: false, message: 'Некорректный код страны' }
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return { ok: false, message: 'Количество: целое число от 1 до 100' }
  }
  return runGmt(() => gmtCreateBulkPurchase(countryCode, quantity))
}

export async function secretGmtBulkStatusAction(
  purchaseId: number,
): Promise<GmtActionResult<GmtBulkPurchase>> {
  if (!Number.isInteger(purchaseId) || purchaseId < 1) {
    return { ok: false, message: 'Некорректный ID закупки' }
  }
  return runGmt(() => gmtBulkStatus(purchaseId))
}

export async function secretGmtBuyAction(
  countryCode: string,
): Promise<GmtActionResult<GmtPurchase>> {
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { ok: false, message: 'Некорректный код страны' }
  }
  return runGmt(() => gmtCreatePurchase(countryCode))
}

export async function secretGmtRequestCodeAction(
  purchaseId: number,
): Promise<
  GmtActionResult<{ purchase: GmtPurchase; code_request: GmtCodeRequest }>
> {
  if (!Number.isInteger(purchaseId) || purchaseId < 1) {
    return { ok: false, message: 'Некорректный ID покупки' }
  }
  return runGmt(() => gmtRequestCode(purchaseId))
}

export async function secretGmtPurchaseDetailsAction(
  purchaseId: number,
): Promise<GmtActionResult<GmtPurchase>> {
  if (!Number.isInteger(purchaseId) || purchaseId < 1) {
    return { ok: false, message: 'Некорректный ID покупки' }
  }
  return runGmt(() => gmtPurchaseDetails(purchaseId))
}

export async function secretGmtRefundAction(
  purchaseId: number,
): Promise<GmtActionResult<GmtPurchase>> {
  if (!Number.isInteger(purchaseId) || purchaseId < 1) {
    return { ok: false, message: 'Некорректный ID покупки' }
  }
  return runGmt(async () => {
    const res = await gmtRefund(purchaseId)
    return res.purchase
  })
}
