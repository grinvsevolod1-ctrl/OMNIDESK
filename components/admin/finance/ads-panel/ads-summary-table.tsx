'use client'

/**
 * Сводная таблица рекламных кабинетов (режим «Таблица» вкладки рекламы).
 * Выделена из ads-panel.tsx; чисто презентационная — мутации через колбэки.
 */

import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { FinanceAdAccount } from '@/lib/finance-types'
import {
  AD_STATUS_META,
  PLATFORM_META,
  accountMetrics,
  formatInt,
  formatPct,
  formatUsd,
  useRates,
} from '@/components/admin/finance/finance-utils'

export function AdsSummaryTable({
  accounts,
  onEdit,
  onTopup,
}: {
  accounts: FinanceAdAccount[]
  onEdit: (a: FinanceAdAccount) => void
  onTopup: (a: FinanceAdAccount) => void
}) {
  const rates = useRates()
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Кабинет</th>
              <th className="px-4 py-2.5 text-right font-medium">Баланс</th>
              <th className="px-4 py-2.5 text-right font-medium">Расход</th>
              <th className="px-4 py-2.5 text-right font-medium">Лиды</th>
              <th className="px-4 py-2.5 text-right font-medium">CPL</th>
              <th className="px-4 py-2.5 text-right font-medium">CTR</th>
              <th className="px-4 py-2.5 text-right font-medium">CR</th>
              <th className="px-4 py-2.5 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const m = accountMetrics(a, rates)
              return (
                <tr
                  key={a.id}
                  className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          AD_STATUS_META[a.status].dot,
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => onEdit(a)}
                        className="truncate font-medium hover:underline"
                      >
                        {a.name}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {PLATFORM_META[a.platform]}
                      </span>
                    </div>
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right font-semibold tabular-nums',
                      m.balance <= 0 && 'text-destructive',
                    )}
                  >
                    {formatUsd(m.balance)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatUsd(m.spend)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatInt(m.leads)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {m.cpl === Number.POSITIVE_INFINITY
                      ? '—'
                      : formatUsd(m.cpl)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatPct(m.ctr)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatPct(m.cr)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => onTopup(a)}
                    >
                      <Plus className="size-3.5" /> Пополнить
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
