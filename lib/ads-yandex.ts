import 'server-only'

import { query } from './db'
import { decrypt } from './crypto'

/**
 * Прямая интеграция с API Яндекс.Директа (Reports, версия v5).
 *
 * Тянем кумулятивные метрики кабинета (показы, клики, конверсии=лиды, расход)
 * за широкий период и складываем их в finance_ad_sync_stats. Итоговые цифры,
 * которые видит пользователь, считаются уже поверх этих «сырых» данных с учётом
 * ручных корректировок (finance_ad_overrides) — см. lib/finance-types.
 *
 * Токен хранится в БД зашифрованным (AES-256-GCM, lib/crypto). Здесь он
 * расшифровывается только в момент запроса и никуда не логируется.
 */

const REPORTS_ENDPOINT = 'https://api.direct.yandex.com/json/v5/reports'

/** Самая ранняя дата, с которой имеет смысл запрашивать историю. */
const HISTORY_START = '2015-01-01'

export interface YandexStats {
  impressions: number
  clicks: number
  leads: number
  spend: number
  periodStart: string
  periodEnd: string
}

export class YandexApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YandexApiError'
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function toNumber(raw: string): number {
  if (!raw || raw === '--') return 0
  const n = Number(raw.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Запрашивает ACCOUNT_PERFORMANCE_REPORT и возвращает суммарные метрики.
 *
 * Отчёт формируется асинхронно: при processingMode=auto API отвечает 200,
 * когда данные готовы, либо 201/202 с Retry-After, пока отчёт в очереди —
 * тогда повторяем запрос. Деньги запрашиваем в обычных единицах
 * (returnMoneyInMicros: false).
 */
export async function fetchYandexDirectStats(params: {
  token: string
  login: string
  dateFrom?: string
  dateTo?: string
}): Promise<YandexStats> {
  const dateFrom = params.dateFrom || HISTORY_START
  const dateTo = params.dateTo || todayIso()

  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
    'Accept-Language': 'ru',
    'Content-Type': 'application/json; charset=utf-8',
    processingMode: 'auto',
    returnMoneyInMicros: 'false',
    skipReportHeader: 'true',
    skipColumnHeader: 'false',
    skipReportSummary: 'true',
  }
  if (params.login.trim()) headers['Client-Login'] = params.login.trim()

  const body = JSON.stringify({
    params: {
      SelectionCriteria: { DateFrom: dateFrom, DateTo: dateTo },
      FieldNames: ['Impressions', 'Clicks', 'Cost', 'Conversions'],
      ReportName: `omnidesk-${Date.now()}`,
      ReportType: 'ACCOUNT_PERFORMANCE_REPORT',
      DateRangeType: 'CUSTOM_DATE',
      Format: 'TSV',
      IncludeVAT: 'YES',
      IncludeDiscount: 'NO',
    },
  })

  const maxAttempts = 6
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response
    try {
      res = await fetch(REPORTS_ENDPOINT, { method: 'POST', headers, body })
    } catch (err) {
      throw new YandexApiError(
        `Сеть недоступна: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // Отчёт ещё формируется — ждём и повторяем.
    if (res.status === 201 || res.status === 202) {
      const retry = Number(res.headers.get('retryIn') || '1')
      await sleep(Math.min(Math.max(retry, 1), 10) * 1000)
      continue
    }

    const text = await res.text()

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new YandexApiError(
        res.status === 401 || res.status === 403
          ? 'Токен отклонён Яндексом (401/403). Проверьте OAuth-токен и логин.'
          : `Яндекс отклонил запрос (400): ${text.slice(0, 300)}`,
      )
    }
    if (res.status !== 200) {
      throw new YandexApiError(
        `Яндекс вернул статус ${res.status}: ${text.slice(0, 300)}`,
      )
    }

    return parseReport(text, dateFrom, dateTo)
  }

  throw new YandexApiError(
    'Отчёт формировался слишком долго — попробуйте синхронизацию позже.',
  )
}

/**
 * Парсит TSV-отчёт. Первая строка — заголовки колонок, дальше строки данных.
 * Без группировок обычно одна строка, но на всякий случай суммируем все.
 */
function parseReport(
  tsv: string,
  periodStart: string,
  periodEnd: string,
): YandexStats {
  const lines = tsv.split('\n').filter((l) => l.trim().length > 0)
  const result: YandexStats = {
    impressions: 0,
    clicks: 0,
    leads: 0,
    spend: 0,
    periodStart,
    periodEnd,
  }
  if (lines.length < 2) return result

  const header = lines[0].split('\t').map((h) => h.trim())
  const idx = {
    impressions: header.indexOf('Impressions'),
    clicks: header.indexOf('Clicks'),
    spend: header.indexOf('Cost'),
    leads: header.indexOf('Conversions'),
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (idx.impressions >= 0) {
      result.impressions += toNumber(cols[idx.impressions])
    }
    if (idx.clicks >= 0) result.clicks += toNumber(cols[idx.clicks])
    if (idx.spend >= 0) result.spend += toNumber(cols[idx.spend])
    if (idx.leads >= 0) result.leads += toNumber(cols[idx.leads])
  }

  result.impressions = Math.round(result.impressions)
  result.clicks = Math.round(result.clicks)
  result.leads = Math.round(result.leads)
  result.spend = Math.round(result.spend * 100) / 100
  return result
}

interface SyncAccountRow {
  id: string
  platform: string
  external_enabled: boolean
  yandex_login: string
  yandex_token_enc: string | null
}

export interface SyncResult {
  ok: boolean
  message: string
  stats?: YandexStats
}

/**
 * Синхронизирует один кабинет: тянет данные из Яндекса и перезаписывает
 * finance_ad_sync_stats. Ошибки не бросает наружу, а фиксирует в sync_error,
 * чтобы cron мог пройти по всем кабинетам, не падая на одном.
 */
export async function syncAdAccount(accountId: string): Promise<SyncResult> {
  const rows = await query<SyncAccountRow>(
    `SELECT id, platform, external_enabled, yandex_login, yandex_token_enc
       FROM finance_ad_accounts
      WHERE id = $1`,
    [accountId],
  )
  const account = rows[0]
  if (!account) return { ok: false, message: 'Кабинет не найден.' }

  if (account.platform !== 'yandex_direct' || !account.external_enabled) {
    return { ok: false, message: 'Интеграция для этого кабинета выключена.' }
  }
  if (!account.yandex_token_enc) {
    return { ok: false, message: 'Не задан OAuth-токен Яндекс.Директа.' }
  }

  let token: string
  try {
    token = decrypt(account.yandex_token_enc)
  } catch {
    return { ok: false, message: 'Не удалось расшифровать токен (ENCRYPTION_KEY).' }
  }

  try {
    const stats = await fetchYandexDirectStats({
      token,
      login: account.yandex_login,
    })

    await query(
      `INSERT INTO finance_ad_sync_stats
         (account_id, period_start, period_end, impressions, clicks, leads, spend, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (account_id) DO UPDATE SET
         period_start = EXCLUDED.period_start,
         period_end   = EXCLUDED.period_end,
         impressions  = EXCLUDED.impressions,
         clicks       = EXCLUDED.clicks,
         leads        = EXCLUDED.leads,
         spend        = EXCLUDED.spend,
         synced_at    = now()`,
      [
        accountId,
        stats.periodStart,
        stats.periodEnd,
        stats.impressions,
        stats.clicks,
        stats.leads,
        stats.spend,
      ],
    )
    await query(
      `UPDATE finance_ad_accounts
          SET last_sync_at = now(), sync_error = ''
        WHERE id = $1`,
      [accountId],
    )
    return { ok: true, message: 'Данные из Яндекс.Директа обновлены.', stats }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Неизвестная ошибка синхронизации.'
    await query(
      `UPDATE finance_ad_accounts
          SET last_sync_at = now(), sync_error = $2
        WHERE id = $1`,
      [accountId, message.slice(0, 500)],
    )
    return { ok: false, message }
  }
}

/** Синхронизирует все кабинеты с включённой интеграцией (для cron). */
export async function syncAllAdAccounts(): Promise<{
  total: number
  ok: number
  failed: number
}> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM finance_ad_accounts
      WHERE external_enabled = true
        AND platform = 'yandex_direct'
        AND yandex_token_enc IS NOT NULL`,
  )
  let ok = 0
  let failed = 0
  for (const row of rows) {
    const result = await syncAdAccount(row.id)
    if (result.ok) ok++
    else failed++
  }
  return { total: rows.length, ok, failed }
}
