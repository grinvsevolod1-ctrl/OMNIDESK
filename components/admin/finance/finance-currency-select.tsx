'use client'

/**
 * Currency dropdown shared by the ad-account and expense-entry dialogs.
 * Split out of finance-dialogs.tsx so both dialog groups can import it
 * without a circular dependency.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FINANCE_CURRENCIES, type FinanceCurrency } from '@/lib/finance-types'
import { CURRENCY_SYMBOL } from '@/components/admin/finance/finance-utils'

export function CurrencySelect({
  name,
  defaultValue,
  value,
  onValueChange,
}: {
  name: string
  defaultValue?: FinanceCurrency
  value?: FinanceCurrency
  onValueChange?: (v: FinanceCurrency) => void
}) {
  return (
    <Select
      name={name}
      defaultValue={defaultValue}
      value={value}
      onValueChange={
        onValueChange
          ? (v) => onValueChange(v as FinanceCurrency)
          : undefined
      }
    >
      <SelectTrigger className="w-[110px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FINANCE_CURRENCIES.map((c) => (
          <SelectItem key={c} value={c}>
            {c} {CURRENCY_SYMBOL[c]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
