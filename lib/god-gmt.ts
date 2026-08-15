import 'server-only'

/**
 * Клиент API Get My TG (магазин Telegram-аккаунтов) — часть god-панели,
 * вкладка «API TG». Подчиняется всем правилам изоляции из AGENTS.md §4:
 * обычная админка и Admin AI не знают о существовании этого модуля.
 *
 * Документация: docs.getmytg.com/sdk-reference (OpenAPI 1.1.4).
 * Аутентификация: заголовок `x-api-key` (ключ выдаёт Telegram-бот сервиса).
 *
 * Ключ назначается ИЗ ПАНЕЛИ (вкладка «API TG») и хранится в БД
 * (god_settings, миграция 139) — по решению владельца, прецедент —
 * api_key_plain god-сайтов (миграция 137). Env `GMT_API_KEY` остаётся
 * fallback'ом: БД имеет приоритет. Без ключа вкладка показывает форму
 * ввода, все actions отвечают ошибкой.
 *
 * Ключевые факты API (из доков), на которые опирается UI:
 * - Покупка PENDING → SUCCESS только после POST /purchases/:id/request-code;
 *   повторный request-code даёт conflict — креды читаются из GET /purchases/:id.
 * - Возврат возможен только для PENDING старше 20 минут.
 * - Цены — строки с 2 знаками; у пользователя есть персональная скидка.
 */

import { query } from './db'

const GMT_BASE_URL = 'https://api.getmytg.com'

/* --------------------------- Хранение ключа ----------------------------- */

const GMT_KEY_SETTING = 'gmt_api_key'

/**
 * Кэш ключа в памяти процесса: server actions дёргают API пачками (SWR),
 * запрос к БД на каждый fetch не нужен. Инвалидируется при set/clear и по
 * TTL — чтобы несколько PM2-процессов сходились после смены ключа.
 */
let keyCache: { value: string | null; at: number } | null = null
const KEY_CACHE_TTL_MS = 15_000

/** Ключ из БД (приоритет) или env (fallback); null — не настроен. */
export async function getGmtApiKey(): Promise<string | null> {
  if (keyCache && Date.now() - keyCache.at < KEY_CACHE_TTL_MS) {
    return keyCache.value
  }
  let dbKey: string | null = null
  try {
    const rows = await query<{ value: string }>(
      `SELECT value FROM god_settings WHERE key = $1`,
      [GMT_KEY_SETTING],
    )
    dbKey = rows[0]?.value?.trim() || null
  } catch {
    // Таблицы ещё нет (миграция не применена) — работаем через env.
  }
  const value = dbKey || process.env.GMT_API_KEY?.trim() || null
  keyCache = { value, at: Date.now() }
  return value
}

/** Сохранить ключ в БД (upsert) и сбросить кэш. Пустой ключ не принимается. */
export async function setGmtApiKey(key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) throw new Error('Пустой ключ')
  await query(
    `INSERT INTO god_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [GMT_KEY_SETTING, trimmed],
  )
  keyCache = null
}

/** Удалить ключ из БД (остаётся только env-fallback, если он задан). */
export async function clearGmtApiKey(): Promise<void> {
  await query(`DELETE FROM god_settings WHERE key = $1`, [GMT_KEY_SETTING])
  keyCache = null
}

/**
 * Откуда взят действующий ключ и его маска для UI. Сам ключ наружу не
 * отдаётся — только последние 4 символа.
 */
export async function getGmtKeyInfo(): Promise<{
  source: 'db' | 'env' | null
  masked: string | null
}> {
  let dbKey: string | null = null
  try {
    const rows = await query<{ value: string }>(
      `SELECT value FROM god_settings WHERE key = $1`,
      [GMT_KEY_SETTING],
    )
    dbKey = rows[0]?.value?.trim() || null
  } catch {
    /* таблицы нет — env-only режим */
  }
  const envKey = process.env.GMT_API_KEY?.trim() || null
  const active = dbKey || envKey
  if (!active) return { source: null, masked: null }
  return {
    source: dbKey ? 'db' : 'env',
    masked: `••••${active.slice(-4)}`,
  }
}

/* ------------------------------- Типы API ------------------------------- */

export interface GmtMoney {
  amount: string
  currency_code: string
}

/**
 * Профиль по докам содержит balance/statistics/discount/referral, но реальный
 * API отдаёт вложенные блоки не всегда (у свежих аккаунтов referral может
 * отсутствовать) — поэтому они опциональны, UI обязан рендерить с фолбэками.
 */
export interface GmtProfile {
  id: string
  telegram_id: string | null
  telegram_username: string | null
  login: string | null
  balance?: GmtMoney
  statistics?: { total_purchases: number }
  discount?: { level: string; percent: number }
  referral?: {
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

/** Разбивка цены по стране: финальная цена + база и процент скидки. */
export interface GmtCountryDetails {
  country_code: string
  emoji: string
  display_name: { ru: string; en: string }
  price: GmtMoney
  discount: { base_price: string; percent: number }
  available: boolean
  tags: string[]
}

/** Оптовая закупка: архив с сессиями появляется в item при SUCCESS. */
export interface GmtBulkPurchase {
  bulk_purchase_id: number
  country_code: string
  quantity: number
  total_price: GmtMoney
  price_per_account: GmtMoney
  item: {
    export_id: string
    archive_url: string
    quantity: number
    status: GmtPurchaseStatus
    created_at: string
  } | null
  status: GmtPurchaseStatus
  created_at: string
  updated_at: string
}

export interface GmtHealth {
  status: 'ok' | 'degraded'
  checks?: { database: boolean; redis: boolean }
  uptimeSeconds: number
  now: string
}

/* ------------------------------ Транспорт ------------------------------- */

export async function isGmtConfigured(): Promise<boolean> {
  return Boolean(await getGmtApiKey())
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
  const apiKey = await getGmtApiKey()
  if (!apiKey) throw new GmtApiError(0, 'Ключ Get My TG не настроен')

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

/** Разбивка цены со скидкой — для чекаута перед покупкой. */
export function gmtCountryDetails(
  countryCode: string,
): Promise<GmtCountryDetails> {
  return gmtFetch<GmtCountryDetails>(`/v1/accounts/${countryCode}`)
}

/**
 * Оптовая закупка: баланс списывается сразу, архив готовится асинхронно.
 * Без callback_url — панель опрашивает статус сама (как и с request-code).
 */
export function gmtCreateBulkPurchase(
  countryCode: string,
  quantity: number,
): Promise<GmtBulkPurchase> {
  return gmtFetch<GmtBulkPurchase>('/v1/purchases/bulk', {
    method: 'POST',
    body: { country_code: countryCode, quantity },
  })
}

export function gmtBulkStatus(purchaseId: number): Promise<GmtBulkPurchase> {
  return gmtFetch<GmtBulkPurchase>(`/v1/purchases/bulk/${purchaseId}`)
}

/**
 * Скачивание ZIP-архива оптовой закупки — сырой Response для проксирования
 * через god-роут (ключ x-api-key не должен попадать в браузер).
 */
export async function gmtBulkDownload(
  purchaseId: number,
): Promise<Response | null> {
  const apiKey = await getGmtApiKey()
  if (!apiKey) return null
  try {
    const res = await fetch(
      `${GMT_BASE_URL}/v1/purchases/bulk/${purchaseId}/download`,
      {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(120_000),
        cache: 'no-store',
      },
    )
    return res.ok ? res : null
  } catch {
    return null
  }
}
