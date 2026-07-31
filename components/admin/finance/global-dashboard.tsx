'use client'

/**
 * Global finance dashboard: cabinet balance cards + lead-source cards across all
 * resources. Extracted from finance-admin.tsx (pure presentational subtree over
 * shared finance-utils) to keep the monolith lean.
 */

import { useMemo } from 'react'
import { ArrowRight, Archive, Layers, Plus, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type {
  AdStatus,
  FinanceAdAccount,
  FinanceEntry,
  FinanceResource,
  VaultItem,
} from '@/lib/finance-types'
import {
  AD_STATUS_META,
  accountMetrics,
  formatInt,
  formatUsd,
  useRates,
  type SubTab,
} from '@/components/admin/finance/finance-utils'

interface CabinetCard {
  account: FinanceAdAccount
  resourceId: string
  resourceName: string
  balance: number
  topups: number
  spend: number
  leads: number
  blocked: boolean
}

interface SourceRow {
  resource: FinanceResource
  leads: number
  balance: number
  activeAccounts: number
  totalAccounts: number
}

/** Статусы, при которых кабинет считаем заблокированным/проблемным. */
const BLOCKED_AD_STATUSES = new Set<AdStatus>(['banned', 'no_funds'])

export function GlobalDashboard({
  resources,
  adAccounts,
  leadCountByResource,
  onOpenResource,
  onCreateResource,
}: {
  resources: FinanceResource[]
  adAccounts: FinanceAdAccount[]
  entries: FinanceEntry[]
  vaultItems: VaultItem[]
  leadCountByResource: Map<string, number>
  onOpenResource: (id: string, tab?: SubTab) => void
  onCreateResource: () => void
}) {
  const rates = useRates()

  const { cabinets, sources } = useMemo(() => {
    const nameById = new Map(resources.map((r) => [r.id, r.name]))
    const cabinets: CabinetCard[] = []
    const sourceAgg = new Map<string, { balance: number; active: number; total: number }>()

    for (const a of adAccounts) {
      if (a.status === 'archived') continue
      const m = accountMetrics(a, rates)
      cabinets.push({
        account: a,
        resourceId: a.resourceId,
        resourceName: nameById.get(a.resourceId) ?? '—',
        balance: m.balance,
        topups: m.topups,
        spend: m.spend,
        leads: m.leads,
        blocked: BLOCKED_AD_STATUSES.has(a.status),
      })
      const agg = sourceAgg.get(a.resourceId) ?? { balance: 0, active: 0, total: 0 }
      agg.balance += m.balance
      agg.total += 1
      if (a.status === 'active') agg.active += 1
      sourceAgg.set(a.resourceId, agg)
    }

    // Проблемные кабинеты — вперёд, затем по возрастанию баланса.
    cabinets.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1
      return a.balance - b.balance
    })

    const sources: SourceRow[] = resources.map((resource) => {
      const agg = sourceAgg.get(resource.id)
      return {
        resource,
        leads: leadCountByResource.get(resource.id) ?? 0,
        balance: agg?.balance ?? 0,
        activeAccounts: agg?.active ?? 0,
        totalAccounts: agg?.total ?? 0,
      }
    })
    sources.sort((a, b) => b.leads - a.leads)

    return { cabinets, sources }
  }, [resources, adAccounts, rates, leadCountByResource])

  return (
    <div className="flex flex-col gap-6">
      {/* Балансы подключённых кабинетов */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Балансы подключённых кабинетов</h3>
          <span className="text-xs text-muted-foreground">· в USD</span>
        </div>
        {cabinets.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Пока нет подключённых кабинетов. Откройте источник лидов и добавьте
            рекламный кабинет.
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cabinets.map((c) => {
              const meta = AD_STATUS_META[c.account.status]
              return (
                <button
                  key={c.account.id}
                  type="button"
                  onClick={() => onOpenResource(c.resourceId, 'ads')}
                  className={cn(
                    'group flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors',
                    c.blocked
                      ? 'border-destructive/50 bg-destructive/5 hover:bg-destructive/10'
                      : 'border-border bg-card hover:bg-muted/50',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.account.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {c.resourceName}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                        meta.className,
                      )}
                    >
                      <span className={cn('size-1.5 rounded-full', meta.dot)} />
                      {meta.label}
                    </span>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Баланс
                    </p>
                    <p
                      className={cn(
                        'text-2xl font-semibold tabular-nums',
                        c.balance <= 0 ? 'text-destructive' : 'text-foreground',
                      )}
                    >
                      {formatUsd(c.balance)}
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Пополнено {formatUsd(c.topups)}</span>
                    <span className="inline-flex items-center gap-1 text-primary opacity-0 transition-opacity group-hover:opacity-100">
                      Подробнее <ArrowRight className="size-3.5" />
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* Источники лидов */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Источники лидов</h3>
          </div>
          <Button size="sm" className="gap-1.5" onClick={onCreateResource}>
            <Plus className="size-4" /> Новый источник лидов
          </Button>
        </div>
        {sources.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Пока нет источников лидов.
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sources.map((s) => (
              <button
                key={s.resource.id}
                type="button"
                onClick={() => onOpenResource(s.resource.id)}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{s.resource.name}</span>
                  {s.resource.archived ? (
                    <Archive className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                </div>
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Лиды
                    </p>
                    <p className="text-xl font-semibold tabular-nums">
                      {formatInt(s.leads)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Баланс
                    </p>
                    <p
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        s.totalAccounts > 0 && s.balance <= 0
                          ? 'text-destructive'
                          : 'text-foreground',
                      )}
                    >
                      {s.totalAccounts > 0 ? formatUsd(s.balance) : '—'}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Кабинетов: {s.activeAccounts}/{s.totalAccounts}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
