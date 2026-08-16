'use client'

/**
 * Per-resource overview panel: KPI row, ad balance summary, cabinets quick list
 * and expenses summary. Extracted from finance-admin.tsx to shrink the monolith.
 */

import {
  ChevronRight,
  CreditCard,
  MousePointerClick,
  Target,
  TrendingDown,
  Users,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { StatCard } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import type {
  FinanceAdAccount,
  FinanceEntry,
  FinanceResource,
} from '@/lib/finance-types'
import {
  AD_STATUS_META,
  PLATFORM_META,
  accountMetrics,
  formatInt,
  formatPct,
  formatUsd,
  useRates,
  type ResourceAdSummary,
} from '@/components/admin/finance/finance-utils'

export function OverviewPanel({
  summary,
  accounts,
  entries,
  onGoAds,
  onGoExpenses,
}: {
  summary: ResourceAdSummary
  accounts: FinanceAdAccount[]
  entries: FinanceEntry[]
  resource: FinanceResource
  onGoAds: () => void
  onGoExpenses: () => void
}) {
  const rates = useRates()
  const expenseTotal = entries
    .filter((e) => e.status !== 'cancelled')
    .reduce((s, e) => s + e.amount, 0)
  const unpaid = entries.filter(
    (e) => e.status === 'planned' || e.status === 'in_progress',
  ).length

  return (
    <div className="flex flex-col gap-5">
      {summary.lowBalance.length > 0 ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
          <TrendingDown className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">
              Заканчивается баланс: {summary.lowBalance.length}
            </p>
            <p className="text-muted-foreground">
              {summary.lowBalance.map((a) => a.name).join(', ')} — пополните
              баланс, чтобы реклама не остановилась.
            </p>
          </div>
        </Card>
      ) : null}

      {/* KPI row (unit-less metrics — safe to sum across currencies) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Лиды"
          value={formatInt(summary.leads)}
          icon={Users}
          hint="Из статистики кабинетов"
        />
        <StatCard
          label="Клики"
          value={formatInt(summary.clicks)}
          icon={MousePointerClick}
          hint={`CTR ${formatPct(summary.ctr)}`}
        />
        <StatCard
          label="Конверсия в лид"
          value={formatPct(summary.cr)}
          icon={Target}
          hint={`${formatInt(summary.impressions)} показов`}
        />
        <StatCard
          label="Кабинеты"
          value={`${summary.activeAccounts}/${summary.totalAccounts}`}
          icon={Wallet}
          hint="Активные / всего"
        />
      </div>

      {/* Balance (USD) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Баланс рекламы</h3>
          <Button variant="ghost" size="sm" onClick={onGoAds}>
            Кабинеты <ChevronRight className="size-4" />
          </Button>
        </div>
        {summary.totalAccounts === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Ещё нет рекламных кабинетов.
          </Card>
        ) : (
          (() => {
            const t = summary.totals
            const cpl = t.leads > 0 ? t.spend / t.leads : null
            const low = t.balance <= 0
            return (
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Общий баланс
                  </span>
                  <Wallet className="size-4 text-muted-foreground" />
                </div>
                <div
                  className={cn(
                    'mt-2 text-2xl font-semibold tabular-nums',
                    low ? 'text-destructive' : 'text-foreground',
                  )}
                >
                  {formatUsd(t.balance)}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                  <Metric label="Пополнено" value={formatUsd(t.topups)} />
                  <Metric label="Расход" value={formatUsd(t.spend)} />
                  <Metric label="Лиды" value={formatInt(t.leads)} />
                  <Metric
                    label="CPL"
                    value={cpl == null ? '—' : formatUsd(cpl)}
                  />
                </div>
              </Card>
            )
          })()
        )}
      </div>

      {/* Accounts quick list */}
      {accounts.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Кабинеты</h3>
          <Card className="divide-y divide-border p-0">
            {accounts.map((a) => {
              const m = accountMetrics(a, rates)
              return (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
                >
                  <div className="flex min-w-[160px] flex-1 items-center gap-2">
                    <span
                      className={cn(
                        'size-2 rounded-full',
                        AD_STATUS_META[a.status].dot,
                      )}
                    />
                    <span className="truncate font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {PLATFORM_META[a.platform]}
                    </span>
                  </div>
                  <div className="tabular-nums text-sm">
                    <span className="text-muted-foreground">Баланс: </span>
                    <span
                      className={cn(
                        'font-semibold',
                        m.balance <= 0 && 'text-destructive',
                      )}
                    >
                      {formatUsd(m.balance)}
                    </span>
                  </div>
                  <div className="tabular-nums text-sm text-muted-foreground">
                    {formatInt(m.leads)} лид. ·{' '}
                    {m.cpl === Number.POSITIVE_INFINITY
                      ? 'CPL —'
                      : `CPL ${formatUsd(m.cpl)}`}
                  </div>
                </div>
              )
            })}
          </Card>
        </div>
      ) : null}

      {/* Expenses summary */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Прочие расходы</h3>
          <Button variant="ghost" size="sm" onClick={onGoExpenses}>
            Открыть <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard
            label="Всего расходов"
            value={formatUsd(expenseTotal)}
            icon={TrendingDown}
            hint={`${entries.length} записей`}
          />
          <StatCard
            label="Не оплачено"
            value={formatInt(unpaid)}
            icon={CreditCard}
            hint="Запланировано / в работе"
          />
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  )
}
