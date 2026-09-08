'use client'

/**
 * Единый компонент отображения денег. Любая сумма ВСЕГДА печатается вместе со
 * своей валютой — так исключается класс багов «2000 ₽ vs 2000 $», когда сумму
 * в одной валюте показывали с символом другой. Никогда не хардкодьте символ
 * валюты в разметке — используйте <Money> или <MoneyStack>.
 */

import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

export interface CurrencyAmount {
  currency: string
  amount: number
}

/** Одна сумма с её валютой. Опционально красит по знаку (баланс). */
export function Money({
  amount,
  currency,
  signedTone = false,
  className,
}: {
  amount: number
  currency: string
  signedTone?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'tabular-nums',
        signedTone && (amount >= 0 ? 'text-success' : 'text-destructive'),
        className,
      )}
    >
      {formatMoney(amount, currency)}
    </span>
  )
}

/**
 * Набор сумм в разных валютах, каждая своей строкой. Медиабайер может вести
 * источники в USD и RUB одновременно — складывать их в одно число нельзя, оба
 * итога показываются рядом. При одной валюте это просто одна строка, при
 * отсутствии данных — «0» в запасной валюте.
 */
export function MoneyStack({
  items,
  fallbackCurrency = 'RUB',
  signedTone = false,
  className,
  lineClassName,
}: {
  items: CurrencyAmount[]
  fallbackCurrency?: string
  signedTone?: boolean
  className?: string
  lineClassName?: string
}) {
  const lines = items.length > 0 ? items : [{ currency: fallbackCurrency, amount: 0 }]
  return (
    <span className={cn('flex flex-col', className)}>
      {lines.map((it) => (
        <Money
          key={it.currency}
          amount={it.amount}
          currency={it.currency}
          signedTone={signedTone}
          className={lineClassName}
        />
      ))}
    </span>
  )
}
