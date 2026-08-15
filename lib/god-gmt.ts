import 'server-only'

/**
 * Клиент API Get My TG (магазин Telegram-аккаунтов) — часть god-панели,
 * вкладка «API TG». Подчиняется всем правилам изоляции из AGENTS.md §4:
 * обычная админка и Admin AI не знают о существовании этого модуля.
 *
 * Документация: docs.getmytg.com/sdk-reference (OpenAPI 1.1.4).
 * Аутентификация: заголовок `x-api-key` (ключ выдаёт Telegram-бот сервиса).
 *
 * FAIL-CLOSED: ключ живёт ТОЛЬКО в env `GMT_API_KEY` (как SECRET_PANEL_PASSWORD)
 * — не в БД, чтобы дамп базы не содержал доступа к балансу. Без ключа вкладка
 * показывает инструкцию по настройке, все actions отвечают ошибкой.
 *
 * Ключевые факты API (из доков), на которые опирается UI:
 * - Покупка PENDING → SUCCESS только после POST /purchases/:id/request-code;
 *   повторный request-code даёт conflict — креды читаются из GET /purchases/:id.
 * - Возврат возможен только для PENDING старше 20 минут.
 * - Цены — строки с 2 знаками; у пользователя есть персональная скидка.
 */

const GMT_BASE_URL = 'https://api.getmytg.com'

/* ------------------------------- Типы API ------------------------------- */

export interface GmtMoney {
  amount: string
  currency_code: string
}

export interface GmtProfile {
  id: string
  telegram_id: string | null
  telegram_username: string | null
  login: string | null
  balance: GmtMoney
  statistics: { total_purchases: number }
  discount: { level: string; percent: number }
  referral: {
    level: string
    percent: number
    referrals_count: number
    balance: GmtMoney
    profit: GmtMoney
  }
  created_at: string
}

export interface GmtCountry {
  country_code: string
  emoji: string
  display_name: { ru: string; en: string }
  price: GmtMoney
  available: boolean
  tags: string[]
  available_count?: number | null
}

export interface GmtPagination {
  current_page: number
  page_size: number
  total_items: number
  total_pages: number
  has_next: boolean
  has_previous: boolean
}

export type GmtPurchaseStatus = 'PENDING' | 'SUCCESS' | 'ERROR' | 'REFUND'

export interface GmtPurchase {
  id: number
  country_code: string
  display_name: { ru: string; en: string }
  phone_number: string | null
  price: GmtMoney
  status: GmtPurchaseStatus
  purchase_type: 'SINGLE' | 'BULK' | 'ADMIN'
  verification: {
    code: string
    password: string
    received_at: string
  } | null
  created_at: string
}

export interface GmtCodeRequest {
  status: 'not_requested' | 'pending' | 'success' | 'failed'
  attempt: number
  max_attempts: number
  next_attempt_at: string | null
  retry_after: number | null
}

export interface GmtHealth {
  status: 'ok' | 'degraded'
  checks?: { database: boolean; redis: boolean }
  uptimeSeconds: number
  now: string
}

/* ------------------------------ Транспорт ------------------------------- */

export function isGmtConfigured(): boolean {
  return Boolean(process.env.GMT_API_KEY)
}

export class GmtApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GmtApiError'
    this.status = status
  }
}

/**
 * Единая точка HTTP: таймаут 30с (request-code может ждать провайдера 5–30с,
 * по докам), явные ошибки со статусом. Ключ НИКОГДА не логируется.
 */
async function gmtFetch<T>(
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  const apiKey = process.env.GMT_API_KEY
  if (!apiKey) throw new GmtApiError(0, 'GMT_API_KEY не настроен')

  let res: Response
  try {
    res = await fetch(`${GMT_BASE_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'x-api-key': apiKey,
        ...(init?.body !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new GmtApiError(0, `Сеть недоступна: ${msg}`)
  }

  if (!res.ok) {
    // Пытаемся вытащить осмысленное сообщение из тела ошибки, но не падаем,
    // если тело не JSON. Текст усечён — не тащим мегабайты в toast.
    let detail = ''
    try {
      const body = (await res.json()) as { message?: string; error?: string }
      detail = body.message ?? body.error ?? ''
    } catch {
      /* тело не JSON — оставляем пустым */
    }
    throw new GmtApiError(
      res.status,
      detail.slice(0, 300) || `HTTP ${res.status}`,
    )
  }

  return (await res.json()) as T
}

/* ------------------------------ Эндпоинты ------------------------------- */

export function gmtHealth(): Promise<GmtHealth> {
  return gmtFetch<GmtHealth>('/v1/service/health')
}

export function gmtProfile(): Promise<GmtProfile> {
  return gmtFetch<GmtProfile>('/v1/profile/')
}

export function gmtCountries(params: {
  sort?: string
  page?: number
  pageSize?: number
}): Promise<{ items: GmtCountry[]; pagination: GmtPagination }> {
  const q = new URLSearchParams({
    sort: params.sort ?? 'popularity_desc',
    page: String(params.page ?? 1),
    page_size: String(params.pageSize ?? 100),
  })
  return gmtFetch(`/v1/accounts/?${q}`)
}

export function gmtPurchases(params: {
  status?: GmtPurchaseStatus
  page?: number
  pageSize?: number
}): Promise<{ items: GmtPurchase[]; pagination: GmtPagination }> {
  const q = new URLSearchParams({
    page: String(params.page ?? 1),
    page_size: String(params.pageSize ?? 50),
  })
  if (params.status) q.set('status', params.status)
  return gmtFetch(`/v1/purchases/?${q}`)
}

export function gmtCreatePurchase(countryCode: string): Promise<GmtPurchase> {
  return gmtFetch<GmtPurchase>('/v1/purchases/', {
    method: 'POST',
    body: { country_code: countryCode },
  })
}

export function gmtRequestCode(
  purchaseId: number,
): Promise<{ purchase: GmtPurchase; code_request: GmtCodeRequest }> {
  // Без callback_url: панель опрашивает статус сама (GET /purchases/:id),
  // вебхук потребовал бы публичного эндпоинта вне god-гейта.
  return gmtFetch(`/v1/purchases/${purchaseId}/request-code`, {
    method: 'POST',
    body: {},
  })
}

export function gmtPurchaseDetails(purchaseId: number): Promise<GmtPurchase> {
  return gmtFetch<GmtPurchase>(`/v1/purchases/${purchaseId}`)
}

export function gmtRefund(purchaseId: number): Promise<{
  purchase: GmtPurchase
  refund: { amount: GmtMoney; reason: string; refunded_at: string }
}> {
  return gmtFetch(`/v1/purchases/${purchaseId}/refund`, {
    method: 'POST',
  })
}
