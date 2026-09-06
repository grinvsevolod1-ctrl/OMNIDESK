/**
 * Форматирование денег для финансов источника (байер/админ/руководитель).
 * Отдельный лёгкий модуль без 'server-only', чтобы использоваться и на клиенте.
 * Совместим по виду с finance-utils.formatMoney (та же локаль и символы).
 */

export const CURRENCY_SYMBOL: Record<string, string> = {
  RUB: '₽',
  USD: '$',
  EUR: '€',
  USDT: '₮',
}

/** «12 500 ₽». Неизвестная валюта печатается кодом после суммы. */
export function formatMoney(amount: number, currency: string): string {
  const n = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
  const sym = CURRENCY_SYMBOL[currency]
  return sym ? `${n} ${sym}` : `${n} ${currency}`
}

/** Компактно: «1,2 млн ₽» для крупных сумм в карточках. */
export function formatMoneyCompact(amount: number, currency: string): string {
  const abs = Math.abs(amount)
  const sym = CURRENCY_SYMBOL[currency] ?? currency
  if (abs >= 1_000_000) {
    return `${(amount / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ${sym}`
  }
  if (abs >= 10_000) {
    return `${(amount / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс ${sym}`
  }
  return formatMoney(amount, currency)
}

/** Проценты с одним знаком: «12,3 %». Бесконечность/NaN → «—». */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`
}
