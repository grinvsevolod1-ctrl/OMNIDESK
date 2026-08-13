'use client'

/**
 * Развёрнутая карточка рекламного кабинета: баланс, метрики, статус
 * синхронизации, действия и раскрывающаяся история пополнений/статистики.
 * Выделена из ads-panel.tsx; чисто презентационная — мутации через колбэки.
 */

import { useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Link as LinkIcon,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
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

export function AdAccountCard({
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
