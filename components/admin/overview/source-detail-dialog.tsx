'use client'

/**
 * Подробная аналитика одного источника трафика для админа/руководителя.
 * Открывается по клику на карточку источника в «Обзоре» (или в отчёте байера)
 * большим модальным окном на ~85% экрана. Данные тянутся клиентски (SWR) через
 * getSourceFinanceReportAction — скоуп по роли уже проверяется на сервере
 * (админ — любой источник, руководитель — только байеров своей команды).
 *
 * Экран для админа/руководителя read-oriented: единственное действие — горячая
 * кнопка «Внести депозит» (бюджет байеру). Траты и подтверждение депозитов
 * ведёт сам байер в своём разделе — здесь это только показывается.
 */

import { useCallback, useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  Coins,
  Loader2,
  Moon,
  MousePointerClick,
  Sun,
  Target,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import {
  getSourceFinanceReportAction,
  type SourceOverviewRow,
} from '@/app/actions/source-finance'
import { DepositDialog } from '@/components/admin/buyers/deposit-dialog'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
} from '@/components/ui/dialog'
import type {
  SourceDeposit,
  SourceFinanceSummary,
  SourceSpendDay,
} from '@/lib/data/source-finance'
import { formatMoney, formatPercent } from '@/lib/money'
import { formatMskDateTime } from '@/lib/time'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { cn } from '@/lib/utils'

/** Минуты от полуночи → «ЧЧ:ММ» (окно дня источника в МСК). */
function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60)
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** ДД.ММ.ГГГГ из ISO-даты лога трат. */
function fmtSpendDate(d: string): string {
  return d.split('-').reverse().join('.')
}

const DEPOSIT_STATUS_META: Record<
  SourceDeposit['status'],
  { label: string; cls: string; dot: string }
> = {
  pending: {
    label: 'Ожидает решения',
    cls: 'border-warning/40 bg-warning/10 text-warning',
    dot: 'bg-warning',
  },
  confirmed: {
    label: 'Подтверждён',
    cls: 'border-success/40 bg-success/10 text-success',
    dot: 'bg-success',
  },
  rejected: {
    label: 'Отклонён',
    cls: 'border-destructive/40 bg-destructive/10 text-destructive',
    dot: 'bg-destructive',
  },
}

/**
 * Управляемая обёртка: рендерит модалку, когда выбран источник (row != null).
 * Держит DepositDialog смонтированным поверх, чтобы «Внести депозит» работал,
 * не закрывая подробный обзор.
 */
export function SourceDetailDialog({
  row,
  onOpenChange,
  onChanged,
}: {
  row: SourceOverviewRow | null
  onOpenChange: (open: boolean) => void
  onChanged?: () => void
}) {
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      {row ? (
        <DialogContent
          showCloseButton={false}
          className="flex h-[85vh] max-h-[85vh] w-[85vw] max-w-[85vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[85vw]"
        >
          <SourceDetailBody row={row} onChanged={onChanged} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function SourceDetailBody({
  row,
  onChanged,
}: {
  row: SourceOverviewRow
  onChanged?: () => void
}) {
  const { source, stats } = row
  const platform = platformOrCustom(source.platformKey)
  const [depositOpen, setDepositOpen] = useState(false)

  const { data, isLoading, mutate } = useSWR(
    ['source-report', source.id],
    () => getSourceFinanceReportAction(source.id),
    { keepPreviousData: true, revalidateOnFocus: false },
  )

  const summary = data?.summary ?? null
  const deposits = data?.deposits ?? []
  const spend = data?.spend ?? []
  const cur = summary?.currency ?? source.currency

  const refresh = useCallback(() => {
    void mutate()
    onChanged?.()
  }, [mutate, onChanged])

  return (
    <>
      {/* Шапка: закреплена, не скроллится */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card/60 px-5 py-4">
        <PlatformLogo platform={platform} size={52} rounded="rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{source.name}</h2>
            {!source.isActive ? (
              <Badge
                variant="outline"
                className="border-transparent bg-muted text-muted-foreground"
              >
                Выключен
              </Badge>
            ) : null}
            {summary && summary.pendingCount > 0 ? (
              <Badge className="border-transparent bg-warning/15 text-warning">
                {summary.pendingCount} депозит(ов) ждут
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {platform.name}
            {source.externalAccount ? ` · ${source.externalAccount}` : ''} · учёт
            в {cur} · владелец: {source.buyerName ?? 'без владельца'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={() => setDepositOpen(true)}>
            <Coins className="size-4" />
            Внести депозит
          </Button>
          <DialogClose
            render={<Button variant="outline" size="sm" />}
          >
            Закрыть
          </DialogClose>
        </div>
      </header>

      {/* Тело: скроллится */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {isLoading && !data ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <span className="sr-only">Загрузка аналитики источника</span>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <MetricsBlock summary={summary} stats={stats} source={source} />

            <div className="grid gap-5 xl:grid-cols-2">
              <DepositsBlock deposits={deposits} currency={cur} />
              <SpendBlock spend={spend} currency={cur} />
            </div>
          </div>
        )}
      </div>

      <DepositDialog
        open={depositOpen}
        onOpenChange={setDepositOpen}
        source={{ id: source.id, name: source.name, currency: cur }}
        onCreated={refresh}
      />
    </>
  )
}

/* ------------------------------- Метрики ------------------------------- */

function MetricsBlock({
  summary,
  stats,
  source,
}: {
  summary: SourceFinanceSummary | null
  stats: SourceOverviewRow['stats']
  source: SourceOverviewRow['source']
}) {
  const cur = summary?.currency ?? source.currency
  return (
    <section aria-label="Ключевые метрики" className="flex flex-col gap-3">
      {/* Финансы */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          icon={Wallet}
          label="Баланс"
          value={summary ? formatMoney(summary.balance, cur) : '—'}
          tone={summary && summary.balance < 0 ? 'negative' : 'positive'}
          hint={
            summary
              ? `Подтверждено ${formatMoney(summary.confirmedDeposits, cur)}`
              : undefined
          }
        />
        <MetricTile
          icon={Coins}
          label="Потрачено"
          value={summary ? formatMoney(summary.totalSpend, cur) : '—'}
          hint={
            summary ? `Освоено ${formatPercent(summary.utilization)}` : undefined
          }
        />
        <MetricTile
          icon={Target}
          label="Лиды"
          value={String(summary?.leads ?? source.leadCount)}
          hint={
            summary && summary.leads > 0
              ? `CPL ${formatMoney(summary.cpl, cur)}`
              : 'CPL —'
          }
        />
        <MetricTile
          icon={TrendingUp}
          label="CTR / CR"
          value={summary ? formatPercent(summary.ctr) : '—'}
          hint={summary ? `CR ${formatPercent(summary.cr)}` : undefined}
        />
      </div>

      {/* Трафик и окно дня */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          icon={MousePointerClick}
          label="Клики / показы"
          value={summary ? summary.clicks.toLocaleString('ru-RU') : '—'}
          hint={
            summary
              ? `${summary.impressions.toLocaleString('ru-RU')} показов`
              : undefined
          }
        />
        <MetricTile
          icon={Sun}
          label="Сегодня в дне"
          value={String(stats?.todayDay ?? 0)}
          hint={`Окно ${fmtMinutes(source.dayStart)}–${fmtMinutes(source.dayEnd)}`}
          tone="amber"
        />
        <MetricTile
          icon={Moon}
          label="Сегодня долёты"
          value={String(stats?.todayNight ?? 0)}
          hint={`${stats?.todayTotal ?? 0} всего за сегодня`}
          tone="sky"
        />
        <MetricTile
          icon={Users}
          label="Всего лидов"
          value={String(stats?.total ?? source.leadCount)}
          hint={`${source.managerCount} менедж.`}
        />
      </div>

      {/* Стоимость переданного лида — важный вывод для руководителя */}
      {summary && summary.leads > 0 && summary.totalSpend > 0 ? (
        <Card className="flex items-center justify-between gap-2 border-primary/20 bg-primary/5 px-4 py-3">
          <span className="text-sm text-muted-foreground">
            Фактическая стоимость лида (потрачено ÷ лиды)
          </span>
          <span className="text-lg font-semibold tabular-nums text-primary">
            {formatMoney(summary.totalSpend / summary.leads, cur)}
          </span>
        </Card>
      ) : null}
    </section>
  )
}

function MetricTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: typeof Wallet
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'positive' | 'negative' | 'amber' | 'sky'
}) {
  const toneCls = {
    default: 'text-foreground',
    positive: 'text-success',
    negative: 'text-destructive',
    amber: 'text-amber-500',
    sky: 'text-sky-500',
  }[tone]
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className={cn('size-3.5', tone === 'default' ? '' : toneCls)} />
        {label}
      </span>
      <span className={cn('text-2xl font-semibold tabular-nums', toneCls)}>
        {value}
      </span>
      {hint ? (
        <span className="truncate text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </Card>
  )
}

/* ------------------------------ Депозиты ------------------------------ */

function DepositsBlock({
  deposits,
  currency,
}: {
  deposits: SourceDeposit[]
  currency: string
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Бюджеты (депозиты)</h3>
        <span className="text-xs text-muted-foreground">
          {deposits.length} всего
        </span>
      </div>
      {deposits.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          Депозитов ещё нет. Внесите бюджет кнопкой «Внести депозит» —
          байер подтвердит и отчитается по нему.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {deposits.map((d) => {
            const meta = DEPOSIT_STATUS_META[d.status]
            const converted =
              d.origCurrency !== currency
                ? ` (${formatMoney(d.origAmount, d.origCurrency)} × ${d.fxRate})`
                : ''
            return (
              <li
                key={d.id}
                className="rounded-xl border border-border bg-background/40 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-semibold tabular-nums">
                      {formatMoney(d.amount, currency)}
                      <span className="text-xs font-normal text-muted-foreground">
                        {converted}
                      </span>
                    </p>
                    {d.purpose ? (
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {d.purpose}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {d.createdByName || 'Администратор'} ·{' '}
                      {formatMskDateTime(d.createdAt)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                      meta.cls,
                    )}
                  >
                    <span className={cn('size-1.5 rounded-full', meta.dot)} />
                    {meta.label}
                  </span>
                </div>
                {d.buyerNote ? (
                  <p className="mt-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                    Комментарий байера: {d.buyerNote}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/* ------------------------------ Лог трат ------------------------------ */

function SpendBlock({
  spend,
  currency,
}: {
  spend: SourceSpendDay[]
  currency: string
}) {
  const totals = useMemo(
    () =>
      spend.reduce(
        (acc, s) => ({
          spend: acc.spend + s.spend,
          impressions: acc.impressions + s.impressions,
          clicks: acc.clicks + s.clicks,
          leads: acc.leads + s.leads,
        }),
        { spend: 0, impressions: 0, clicks: 0, leads: 0 },
      ),
    [spend],
  )

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Дневной лог трат</h3>
        <span className="text-xs text-muted-foreground">{spend.length} дн.</span>
      </div>
      {spend.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          Байер ещё не вносил траты. Дневной лог ведёт он сам в своём разделе.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Дата</th>
                <th className="px-3 py-2 text-right font-medium">Расход</th>
                <th className="px-3 py-2 text-right font-medium">Показы</th>
                <th className="px-3 py-2 text-right font-medium">Клики</th>
                <th className="px-3 py-2 text-right font-medium">Лиды</th>
              </tr>
            </thead>
            <tbody>
              {spend.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-3 py-2 tabular-nums">
                    {fmtSpendDate(s.spendDate)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {formatMoney(s.spend, currency)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {s.impressions.toLocaleString('ru-RU')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {s.clicks.toLocaleString('ru-RU')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {s.leads.toLocaleString('ru-RU')}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/30 font-medium">
                <td className="px-3 py-2">Итого</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMoney(totals.spend, currency)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {totals.impressions.toLocaleString('ru-RU')}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {totals.clicks.toLocaleString('ru-RU')}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {totals.leads.toLocaleString('ru-RU')}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  )
}
