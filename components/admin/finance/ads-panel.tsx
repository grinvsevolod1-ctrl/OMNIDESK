'use client'

/**
 * Ad-accounts tab for a finance resource, extracted from the finance-admin
 * monolith. Renders the ad-account cards / summary table, low-balance alerts
 * and the lazily-loaded spend trend chart. Purely presentational: every
 * mutation is delegated to the parent via on* callback props.
 */

import { useState } from 'react'
import dynamic from 'next/dynamic'
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Layers,
  Link as LinkIcon,
  Pencil,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  TrendingDown,
  Wallet,
  X,
} from 'lucide-react'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { toUsd, type FinanceAdAccount } from '@/lib/finance-types'
import {
  AD_STATUS_META,
  PLATFORM_META,
  accountMetrics,
  formatDate,
  formatDateTime,
  formatInt,
  formatPct,
  formatUsd,
  useRates,
} from '@/components/admin/finance/finance-utils'

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

function AdsSummaryTable({
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

function AdAccountCard({
  account,
  pending,
  onEdit,
  onTopup,
  onStat,
  onSync,
  onDelete,
  onDeleteTopup,
  onDeleteStat,
}: {
  account: FinanceAdAccount
  pending: boolean
  onEdit: () => void
  onTopup: () => void
  onStat: () => void
  onSync: () => void
  onDelete: () => void
  onDeleteTopup: (id: string) => void
  onDeleteStat: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rates = useRates()
  const m = accountMetrics(account, rates)
  const status = AD_STATUS_META[account.status]
  const low = m.balance <= 0

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{account.name}</span>
            <Badge
              variant="outline"
              className={cn('gap-1.5 font-medium', status.className)}
            >
              <span className={cn('size-1.5 rounded-full', status.dot)} />
              {status.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {PLATFORM_META[account.platform]}
            {account.accountRef ? ` · ${account.accountRef}` : ''}
          </p>
          {account.externalEnabled ? (
            <Badge
              variant="outline"
              className="mt-1.5 gap-1 border-primary/30 bg-primary/5 text-primary"
            >
              <LinkIcon className="size-3" />
              Яндекс.Директ
            </Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onEdit}
            aria-label="Изменить кабинет"
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label="Удалить кабинет"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {/* Balance */}
      <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
        <span className="text-xs text-muted-foreground">Баланс</span>
        <div
          className={cn(
            'text-3xl font-bold tabular-nums',
            low ? 'text-destructive' : 'text-foreground',
          )}
        >
          {formatUsd(m.balance)}
        </div>
        <div className="mt-1 text-xs text-muted-foreground tabular-nums">
          Пополнено {formatUsd(m.topups)} · Расход{' '}
          {formatUsd(m.spend)}
        </div>
      </div>

      {/* Metrics grid */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <MiniMetric label="Показы" value={formatInt(m.impressions)} />
        <MiniMetric label="Клики" value={formatInt(m.clicks)} />
        <MiniMetric label="Лиды" value={formatInt(m.leads)} />
        <MiniMetric label="CTR" value={formatPct(m.ctr)} />
        <MiniMetric label="Конв." value={formatPct(m.cr)} />
        <MiniMetric
          label="CPL"
          value={
            m.cpl === Number.POSITIVE_INFINITY
              ? '—'
              : formatUsd(m.cpl)
          }
        />
      </div>

      {account.note ? (
        <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {account.note}
        </p>
      ) : null}

      {/* Sync status (integration) */}
      {account.externalEnabled ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          {account.syncError ? (
            <>
              <AlertTriangle className="size-3.5 text-destructive" />
              <span className="text-destructive">
                Ошибка синхронизации: {account.syncError}
              </span>
            </>
          ) : account.lastSyncAt ? (
            <>
              <RefreshCw className="size-3.5" />
              <span>Синхронизировано {formatDateTime(account.lastSyncAt)}</span>
            </>
          ) : (
            <>
              <AlertTriangle className="size-3.5" />
              <span>Ещё не синхронизировано — нажмите «Обновить».</span>
            </>
          )}
        </div>
      ) : null}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" className="gap-1.5" onClick={onTopup}>
          <CreditCard className="size-4" /> Пополнить
        </Button>
        {account.externalEnabled ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={onSync}
            disabled={pending}
          >
            <RefreshCw
              className={cn('size-4', pending && 'animate-spin')}
            />
            Обновить
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={onStat}
          >
            <BarChart3 className="size-4" /> Статистика
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto gap-1.5"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
          История
        </Button>
      </div>

      {/* History */}
      {open ? (
        <div className="mt-3 grid gap-4 border-t border-border pt-3 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Пополнения
            </h4>
            {account.topups.length === 0 ? (
              <p className="text-xs text-muted-foreground">Нет пополнений.</p>
            ) : (
              <ul className="space-y-1.5">
                {account.topups.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="font-medium tabular-nums text-success">
                        +{formatUsd(toUsd(t.amount, account.currency, rates))}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatDate(t.topupDate)}
                      </span>
                      {t.note ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {t.note}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onDeleteTopup(t.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Удалить пополнение"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Статистика
            </h4>
            {account.stats.length === 0 ? (
              <p className="text-xs text-muted-foreground">Нет записей.</p>
            ) : (
              <ul className="space-y-1.5">
                {account.stats.map((st) => (
                  <li
                    key={st.id}
                    className="flex items-start justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="text-xs text-muted-foreground">
                        {formatDate(st.periodStart)} — {formatDate(st.periodEnd)}
                      </div>
                      <div className="tabular-nums">
                        <span className="font-medium text-destructive">
                          −{formatUsd(toUsd(st.spend, account.currency, rates))}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {formatInt(st.clicks)} кл · {formatInt(st.leads)} лид.
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onDeleteStat(st.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Удалить запись статистики"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-1 py-2">
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}
