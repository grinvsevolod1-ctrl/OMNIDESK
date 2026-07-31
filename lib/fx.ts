/**
 * Курсы валют в USD.
 *
 * Источник — бесплатный open.er-api.com (без ключа). Возвращает `rates`,
 * где значение = сколько единиц валюты в 1 USD. Мы инвертируем это в
 * «сколько USD стоит 1 единица валюты», чтобы удобно замораживать курс
 * расхода на момент добавления.
 *
 * Server-only: тянет данные через fetch и держит их в кэше на час.
 */

import { DEFAULT_USD_RATES, type UsdRates } from './finance-types'

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 час
const FX_ENDPOINT = 'https://open.er-api.com/v6/latest/USD'

let cache: { at: number; rates: UsdRates } | null = null
let inflight: Promise<UsdRates> | null = null

async function fetchUsdRates(): Promise<UsdRates> {
  const res = await fetch(FX_ENDPOINT, { next: { revalidate: 3600 } })
  if (!res.ok) throw new Error(`FX HTTP ${res.status}`)
  const json = (await res.json()) as {
    result?: string
    rates?: Record<string, number>
  }
  if (json.result !== 'success' || !json.rates) {
    throw new Error('FX: некорректный ответ')
  }
  const r = json.rates
  const usdPerUnit = (code: string, fallback: number) => {
    const perUsd = r[code]
    return typeof perUsd === 'number' && perUsd > 0 ? 1 / perUsd : fallback
  }
  return {
    USD: 1,
    USDT: 1,
    RUB: usdPerUnit('RUB', DEFAULT_USD_RATES.RUB),
    EUR: usdPerUnit('EUR', DEFAULT_USD_RATES.EUR),
  }
}

/**
 * Актуальные курсы (USD за 1 единицу валюты). Кэшируются на час; при сбое
 * API отдаём последний удачный снимок либо статический резерв.
 */
export async function getUsdRates(): Promise<UsdRates> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rates
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const rates = await fetchUsdRates()
      cache = { at: Date.now(), rates }
      return rates
    } catch {
      return cache?.rates ?? DEFAULT_USD_RATES
    } finally {
      inflight = null
    }
  })()

  return inflight
}
