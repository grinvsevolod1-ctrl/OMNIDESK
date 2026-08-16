'use client'

/**
 * Ad-accounts tab for a finance resource, extracted from the finance-admin
 * monolith. Renders the ad-account cards / summary table, low-balance alerts
 * and the lazily-loaded spend trend chart. Purely presentational: every
 * mutation is delegated to the parent via on* callback props.
 *
 * Карточка кабинета — ads-panel/ad-account-card.tsx, сводная таблица —
 * ads-panel/ads-summary-table.tsx.
 */

import { useState } from 'react'
import dynamic from 'next/dynamic'
import {
  BarChart3,
  Layers,
  Plus,
  Table2,
  TrendingDown,
  Wallet,
} from 'lucide-react'
import { EmptyState } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { FinanceAdAccount } from '@/lib/finance-types'
import {
  accountMetrics,
  useRates,
} from '@/components/admin/finance/finance-utils'
import { AdAccountCard } from './ads-panel/ad-account-card'
import { AdsSummaryTable } from './ads-panel/ads-summary-table'

// Recharts is heavy (~100kb+); load the ads trend chart only when its tab is
// actually rendered, keeping it out of the initial finance bundle. ssr:false
// because the chart measures its container and has no useful SSR HTML.
const AdsTrendChart = dynamic(
  () => import('../finance-charts').then((m) => m.AdsTrendChart),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse rounded-lg bg-muted/40" />,
  },
)

export function AdsPanel({
  accounts,
  pending,
  onAdd,
  onEdit,
  onTopup,
  onStat,
  onSync,
  onDeleteAccount,
  onDeleteTopup,
  onDeleteStat,
}: {
  accounts: FinanceAdAccount[]
  pending: boolean
  onAdd: () => void
  onEdit: (a: FinanceAdAccount) => void
  onTopup: (a: FinanceAdAccount) => void
  onStat: (a: FinanceAdAccount) => void
  onSync: (a: FinanceAdAccount) => void
  onDeleteAccount: (a: FinanceAdAccount) => void
  onDeleteTopup: (id: string) => void
  onDeleteStat: (id: string) => void
}) {
  const [layout, setLayout] = useState<'cards' | 'table'>('cards')
  const rates = useRates()

  const lowBalance = accounts.filter(
    (a) =>
      a.status !== 'archived' &&
      accountMetrics(a, rates).balance <= 0 &&
      accountMetrics(a, rates).topups > 0,
  )
  const hasStats = accounts.some((a) => a.stats.length > 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {accounts.length} кабинет(ов)
        </p>
        <div className="flex items-center gap-2">
          {accounts.length > 0 ? (
            <div className="inline-flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                onClick={() => setLayout('cards')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                  layout === 'cards'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Layers className="size-4" /> Карточки
              </button>
              <button
                type="button"
                onClick={() => setLayout('table')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                  layout === 'table'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Table2 className="size-4" /> Таблица
              </button>
            </div>
          ) : null}
          <Button className="gap-1.5" onClick={onAdd}>
            <Plus className="size-4" /> Кабинет
          </Button>
        </div>
      </div>

      {lowBalance.length > 0 ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-3.5">
          <TrendingDown className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">
              Заканчивается баланс: {lowBalance.length}
            </p>
            <p className="text-muted-foreground">
              {lowBalance.map((a) => a.name).join(', ')} — пополните, чтобы
              реклама не остановилась.
            </p>
          </div>
        </Card>
      ) : null}

      {hasStats ? (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <BarChart3 className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Динамика лидов и кликов</h3>
          </div>
          <AdsTrendChart accounts={accounts} />
        </Card>
      ) : null}

      {accounts.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="Нет рекламных кабинетов"
          description="Добавьте кабинет (Яндекс Директ, Google Ads и т.д.), затем пополняйте баланс и вносите статистику."
          action={
            <Button className="gap-1.5" onClick={onAdd}>
              <Plus className="size-4" /> Добавить кабинет
            </Button>
          }
        />
      ) : layout === 'table' ? (
        <AdsSummaryTable accounts={accounts} onEdit={onEdit} onTopup={onTopup} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {accounts.map((a) => (
            <AdAccountCard
              key={a.id}
              account={a}
              pending={pending}
              onEdit={() => onEdit(a)}
              onTopup={() => onTopup(a)}
              onStat={() => onStat(a)}
              onSync={() => onSync(a)}
              onDelete={() => onDeleteAccount(a)}
              onDeleteTopup={onDeleteTopup}
              onDeleteStat={onDeleteStat}
            />
          ))}
        </div>
      )}
    </div>
  )
}
