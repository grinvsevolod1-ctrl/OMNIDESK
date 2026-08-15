'use server'

import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  GmtApiError,
  gmtCountries,
  gmtCreatePurchase,
  gmtHealth,
  gmtProfile,
  gmtPurchaseDetails,
  gmtPurchases,
  gmtRefund,
  gmtRequestCode,
  isGmtConfigured,
  type GmtCodeRequest,
  type GmtCountry,
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
  GmtCodeRequest,
  GmtCountry,
  GmtMoney,
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
  if (!isGmtConfigured()) {
    return {
      ok: false,
      message:
        'GMT_API_KEY не настроен. Добавьте ключ в env на VPS и перезапустите панель.',
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
  }>
> {
  await requireGod()
  if (!isGmtConfigured()) {
    return {
      ok: true,
      message: 'OK',
      data: { configured: false, health: 'unreachable' },
    }
  }
  try {
    const h = await gmtHealth()
    return {
      ok: true,
      message: 'OK',
      data: { configured: true, health: h.status },
    }
  } catch {
    return {
      ok: true,
      message: 'OK',
      data: { configured: true, health: 'unreachable' },
    }
  }
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
): Promise<GmtActionResult<GmtPurchase[]>> {
  return runGmt(async () => {
    const res = await gmtPurchases({ status, pageSize: 50 })
    return res.items
  })
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
