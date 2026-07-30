/**
 * Finance ad accounts: accounts, top-ups, spend stats and metric overrides (CRUD).
 */

import {
  query,
} from '../db'
import {
  encrypt,
} from '../crypto'
import {
  type AdMetricKey,
  type AdPlatform,
  type AdStatus,
  type FinanceCurrency,
} from '../finance-types'
import {
  type AdSyncStatRow,
} from './rows'

/* Ad accounts                                                         */
/* ------------------------------------------------------------------ */

export async function createFinanceAdAccount(input: {
  resourceId: string
  name: string
  platform: AdPlatform
  status: AdStatus
  accountRef: string
  currency: FinanceCurrency
  note: string
  externalEnabled: boolean
  yandexLogin: string
  /** Открытый OAuth-токен; шифруется здесь. '' = без токена. */
  yandexToken: string
}): Promise<void> {
  const tokenEnc = input.yandexToken ? encrypt(input.yandexToken) : null
  await query(
    `INSERT INTO finance_ad_accounts
       (resource_id, name, platform, status, account_ref, currency, note,
        external_enabled, yandex_login, yandex_token_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.resourceId,
      input.name,
      input.platform,
      input.status,
      input.accountRef,
      input.currency,
      input.note,
      input.externalEnabled,
      input.yandexLogin,
      tokenEnc,
    ],
  )
}

export async function updateFinanceAdAccount(
  id: string,
  input: {
    name: string
    platform: AdPlatform
    status: AdStatus
    accountRef: string
    currency: FinanceCurrency
    note: string
    externalEnabled: boolean
    yandexLogin: string
    /** undefined/'' = не менять токен; строка = задать новый. */
    yandexToken?: string
  },
): Promise<void> {
  // Токен обновляем только если передали новое значение — иначе сохраняем
  // существующий зашифрованный токен (COALESCE на NULL).
  const tokenEnc = input.yandexToken ? encrypt(input.yandexToken) : null
  await query(
    `UPDATE finance_ad_accounts
        SET name = $2, platform = $3, status = $4, account_ref = $5,
            currency = $6, note = $7, external_enabled = $8, yandex_login = $9,
            yandex_token_enc = COALESCE($10, yandex_token_enc),
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.name,
      input.platform,
      input.status,
      input.accountRef,
      input.currency,
      input.note,
      input.externalEnabled,
      input.yandexLogin,
      tokenEnc,
    ],
  )
}

/* ------------------------------------------------------------------ */
/* Ad metrics: base values + god-page overrides                        */
/* ------------------------------------------------------------------ */

/**
 * «Сырые» метрики кабинета на сервере: из последнего снимка Яндекса, если
 * интеграция включена, иначе — сумма ручных снимков статистики. Используется
 * god-страницей, чтобы зафиксировать baseline в момент установки корректировки.
 */
export async function getAdBaseMetrics(
  accountId: string,
): Promise<Record<AdMetricKey, number>> {
  const accRows = await query<{ external_enabled: boolean }>(
    `SELECT external_enabled FROM finance_ad_accounts WHERE id = $1`,
    [accountId],
  )
  if (!accRows[0]) return { impressions: 0, clicks: 0, leads: 0, spend: 0 }

  if (accRows[0].external_enabled) {
    const rows = await query<AdSyncStatRow>(
      `SELECT account_id, period_start, period_end, impressions, clicks,
              leads, spend, synced_at
         FROM finance_ad_sync_stats WHERE account_id = $1`,
      [accountId],
    )
    const s = rows[0]
    return {
      impressions: s ? Number(s.impressions) || 0 : 0,
      clicks: s ? Number(s.clicks) || 0 : 0,
      leads: s ? Number(s.leads) || 0 : 0,
      spend: s ? Number(s.spend) || 0 : 0,
    }
  }

  const rows = await query<{
    impressions: string | number
    clicks: string | number
    leads: string | number
    spend: string | number
  }>(
    `SELECT COALESCE(SUM(impressions), 0) AS impressions,
            COALESCE(SUM(clicks), 0)      AS clicks,
            COALESCE(SUM(leads), 0)       AS leads,
            COALESCE(SUM(spend), 0)       AS spend
       FROM finance_ad_stats WHERE account_id = $1`,
    [accountId],
  )
  const s = rows[0]
  return {
    impressions: Number(s?.impressions) || 0,
    clicks: Number(s?.clicks) || 0,
    leads: Number(s?.leads) || 0,
    spend: Number(s?.spend) || 0,
  }
}

/** Зафиксировать ручную корректировку метрики с текущим baseline из Яндекса. */
export async function setAdOverride(
  accountId: string,
  metric: AdMetricKey,
  value: number,
): Promise<void> {
  const base = await getAdBaseMetrics(accountId)
  await query(
    `INSERT INTO finance_ad_overrides (account_id, metric, value, baseline, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (account_id, metric) DO UPDATE SET
       value = EXCLUDED.value,
       baseline = EXCLUDED.baseline,
       updated_at = now()`,
    [accountId, metric, value, base[metric]],
  )
}

/** Снять ручную корректировку — метрика снова показывает данные Яндекса. */
export async function clearAdOverride(
  accountId: string,
  metric: AdMetricKey,
): Promise<void> {
  await query(
    `DELETE FROM finance_ad_overrides WHERE account_id = $1 AND metric = $2`,
    [accountId, metric],
  )
}

export async function deleteFinanceAdAccount(id: string): Promise<void> {
  await query(`DELETE FROM finance_ad_accounts WHERE id = $1`, [id])
}

/* ------------------------------------------------------------------ */
/* Ad top-ups                                                          */
/* ------------------------------------------------------------------ */

export async function addFinanceAdTopup(input: {
  accountId: string
  amount: number
  topupDate: string
  note: string
}): Promise<void> {
  await query(
    `INSERT INTO finance_ad_topups (account_id, amount, topup_date, note)
     VALUES ($1, $2, $3, $4)`,
    [input.accountId, input.amount, input.topupDate, input.note],
  )
}

export async function deleteFinanceAdTopup(id: string): Promise<void> {
  await query(`DELETE FROM finance_ad_topups WHERE id = $1`, [id])
}

/* ------------------------------------------------------------------ */
/* Ad stats                                                            */
/* ------------------------------------------------------------------ */

export async function addFinanceAdStat(input: {
  accountId: string
  periodStart: string
  periodEnd: string
  impressions: number
  clicks: number
  leads: number
  spend: number
  note: string
}): Promise<void> {
  await query(
    `INSERT INTO finance_ad_stats
       (account_id, period_start, period_end, impressions, clicks, leads, spend, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.accountId,
      input.periodStart,
      input.periodEnd,
      input.impressions,
      input.clicks,
      input.leads,
      input.spend,
      input.note,
    ],
  )
}

export async function deleteFinanceAdStat(id: string): Promise<void> {
  await query(`DELETE FROM finance_ad_stats WHERE id = $1`, [id])
}
