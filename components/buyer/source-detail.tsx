'use client'

/**
 * Детальный учёт источника байера. Три блока:
 *   1) Сводка баланса и метрик (баланс, освоение бюджета, CPL/CTR/CR).
 *   2) Депозиты (бюджеты) от админа/руководителя — байер подтверждает/отклоняет
 *      и отчитывается; pending подсвечены и требуют решения.
 *   3) Дневной лог трат — байер вносит расход и метрики (upsert по дню).
 */

import { useCallback, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Check,
  Coins,
  Loader2,
  Plus,
  Target,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  decideDepositAction,
  deleteSpendDayAction,
  getBuyerSourceFinanceAction,
  upsertSpendDayAction,
} from '@/app/actions/source-finance'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRealtimeRefresh } from '@/lib/hooks/use-lead-events'
import type { TrafficSource } from '@/lib/data/traffic-sources'
import type {
  SourceDeposit,
  SourceFinanceSummary,
  SourceSpendDay,
} from '@/lib/data/source-finance'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { formatMoney, formatPercent } from '@/lib/money'
import { formatMskDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

interface FinanceData {
  summary: SourceFinanceSummary
  deposits: SourceDeposit[]
  spend: SourceSpendDay[]
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

/** Крупная плитка метрики баланса. */
function StatTile({
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
  tone?: 'default' | 'positive' | 'negative' | 'warning'
}) {
  const toneCls = {
    default: 'text-foreground',
    positive: 'text-success',
    negative: 'text-destructive',
    warning: 'text-warning',
  }[tone]
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </span>
      <span className={cn('text-2xl font-semibold tabular-nums', toneCls)}>
        {value}
      </span>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </Card>
  )
}

export function BuyerSourceDetail({
  source,
  initialFinance,
}: {
  source: TrafficSource
  initialFinance: FinanceData
}) {
  const router = useRouter()
  const [data, setData] = useState<FinanceData>(initialFinance)
  const platform = platformOrCustom(source.platformKey)
  const cur = data.summary.currency

  const refresh = useCallback(async () => {
    setData(await getBuyerSourceFinanceAction(source.id))
    router.refresh()
  }, [source.id, router])

  // Живой учёт: если депозит/расход/сам источник поменялись (в т.ч. решение
  // админа по депозиту в другой вкладке) — событие 'source' этого источника
  // (миграция 170) тихо перечитывает финансы без ручного обновления.
  useRealtimeRefresh({
    onRefresh: () => void refresh(),
    source: true,
    sourceId: source.id,
  })

  return (
    <div className="flex w-full flex-col gap-5">
      {/* Шапка источника */}
      <div className="flex items-center gap-3">
        <Link
          href="/buyer"
          aria-label="Назад к источникам"
          className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <PlatformLogo platform={platform} size={44} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{source.name}</h1>
          <p className="text-xs text-muted-foreground">
            {platform.name}
            {source.externalAccount ? ` · ${source.externalAccount}` : ''} ·
            учёт в {cur}
          </p>
        </div>
        {data.summary.pendingCount > 0 ? (
          <span className="rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs font-medium text-warning">
            {data.summary.pendingCount} депозит(ов) ждут решения
          </span>
        ) : null}
      </div>

      {/* Сводка баланса и метрик */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={Wallet}
          label="Баланс"
          value={formatMoney(data.summary.balance, cur)}
          tone={data.summary.balance >= 0 ? 'positive' : 'negative'}
          hint={`Подтверждено ${formatMoney(data.summary.confirmedDeposits, cur)}`}
        />
        <StatTile
          icon={Coins}
          label="Потрачено"
          value={formatMoney(data.summary.totalSpend, cur)}
          hint={`Освоено ${formatPercent(data.summary.utilization)}`}
        />
        <StatTile
          icon={Target}
          label="Лиды"
          value={String(data.summary.leads)}
          hint={`CPL ${data.summary.leads > 0 ? formatMoney(data.summary.cpl, cur) : '—'}`}
        />
        <StatTile
          icon={TrendingUp}
          label="CTR / CR"
          value={`${formatPercent(data.summary.ctr)}`}
          hint={`CR ${formatPercent(data.summary.cr)} · ${data.summary.clicks} кликов`}
        />
      </div>

      {/* Депозиты и лог трат */}
      <div className="grid gap-5 lg:grid-cols-2">
        <DepositsPanel
          deposits={data.deposits}
          sourceId={source.id}
          currency={cur}
          onChanged={refresh}
        />
        <SpendPanel
          spend={data.spend}
          sourceId={source.id}
          currency={cur}
          onChanged={refresh}
        />
      </div>
    </div>
  )
}

/* ------------------------------ Депозиты ------------------------------ */

function DepositsPanel({
  deposits,
  sourceId,
  currency,
  onChanged,
}: {
  deposits: SourceDeposit[]
  sourceId: string
  currency: string
  onChanged: () => void
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Бюджеты (депозиты)</h2>
        <span className="text-xs text-muted-foreground">
          {deposits.length} всего
        </span>
      </div>
      {deposits.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
          Пока нет депозитов. Их вносит администратор или руководитель — вы
          подтвердите и отчитаетесь.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {deposits.map((d) => (
            <DepositRow
              key={d.id}
              deposit={d}
              sourceId={sourceId}
              currency={currency}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </Card>
  )
}

function DepositRow({
  deposit,
  sourceId,
  currency,
  onChanged,
}: {
  deposit: SourceDeposit
  sourceId: string
  currency: string
  onChanged: () => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [pending, startTransition] = useTransition()
  const meta = DEPOSIT_STATUS_META[deposit.status]

  function decide(decision: 'confirmed' | 'rejected') {
    if (decision === 'rejected' && !note.trim()) {
      toast.error('Укажите причину отклонения.')
      return
    }
    startTransition(async () => {
      try {
        await decideDepositAction({
          depositId: deposit.id,
          sourceId,
          decision,
          note: note.trim() || undefined,
        })
        toast.success(
          decision === 'confirmed' ? 'Депозит подтверждён.' : 'Депозит отклонён.',
        )
        setRejecting(false)
        setNote('')
        onChanged()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось сохранить.')
      }
    })
  }

  const converted =
    deposit.origCurrency !== currency
      ? ` (${formatMoney(deposit.origAmount, deposit.origCurrency)} × ${deposit.fxRate})`
      : ''

  return (
    <li className="rounded-xl border border-border bg-background/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold tabular-nums">
            {formatMoney(deposit.amount, currency)}
            <span className="text-xs font-normal text-muted-foreground">
              {converted}
            </span>
          </p>
          {deposit.purpose ? (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {deposit.purpose}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {deposit.createdByName || 'Администратор'} ·{' '}
            {formatMskDateTime(deposit.createdAt)}
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

      {deposit.buyerNote ? (
        <p className="mt-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
          Комментарий: {deposit.buyerNote}
        </p>
      ) : null}

      {deposit.status === 'pending' ? (
        rejecting ? (
          <div className="mt-3 space-y-2">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Причина отклонения…"
              rows={2}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRejecting(false)
                  setNote('')
                }}
              >
                Отмена
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={() => decide('rejected')}
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Отклонить
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={pending}
              onClick={() => decide('confirmed')}
            >
              <Check className="size-4" />
              Подтвердить
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              disabled={pending}
              onClick={() => setRejecting(true)}
            >
              <X className="size-4" />
              Отклонить
            </Button>
          </div>
        )
      ) : null}
    </li>
  )
}

/* ---------------------------- Лог трат ---------------------------- */

function SpendPanel({
  spend,
  sourceId,
  currency,
  onChanged,
}: {
  spend: SourceSpendDay[]
  sourceId: string
  currency: string
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Дневной лог трат</h2>
        <Button
          size="sm"
          variant={adding ? 'secondary' : 'default'}
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="size-4" />
          Внести день
        </Button>
      </div>

      {adding ? (
        <SpendForm
          sourceId={sourceId}
          onDone={() => {
            setAdding(false)
            onChanged()
          }}
        />
      ) : null}

      {spend.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
          Ещё нет записей. Вносите ежедневный расход и метрики, чтобы вести учёт
          и отчитываться по бюджету.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Дата</th>
                <th className="px-3 py-2 text-right font-medium">Расход</th>
                <th className="px-3 py-2 text-right font-medium">Показы</th>
                <th className="px-3 py-2 text-right font-medium">Клики</th>
                <th className="px-3 py-2 text-right font-medium">Лиды</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {spend.map((s) => (
                <SpendRow
                  key={s.id}
                  row={s}
                  sourceId={sourceId}
                  currency={currency}
                  onChanged={onChanged}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function SpendForm({
  sourceId,
  onDone,
}: {
  sourceId: string
  onDone: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [spendDate, setSpendDate] = useState(today)
  const [spend, setSpend] = useState('')
  const [impressions, setImpressions] = useState('')
  const [clicks, setClicks] = useState('')
  const [leads, setLeads] = useState('')
  const [pending, startTransition] = useTransition()

  function submit() {
    const spendNum = Number.parseFloat(spend)
    if (!Number.isFinite(spendNum) || spendNum < 0) {
      toast.error('Введите корректный расход.')
      return
    }
    startTransition(async () => {
      try {
        await upsertSpendDayAction({
          sourceId,
          spendDate,
          spend: spendNum,
          impressions: Number.parseInt(impressions) || 0,
          clicks: Number.parseInt(clicks) || 0,
          leads: Number.parseInt(leads) || 0,
        })
        toast.success('День сохранён.')
        onDone()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось сохранить.')
      }
    })
  }

  return (
    <div className="grid grid-cols-2 gap-2.5 rounded-xl border border-border bg-background/40 p-3 sm:grid-cols-3">
      <div className="col-span-2 space-y-1 sm:col-span-1">
        <Label className="text-xs">Дата</Label>
        <Input
          type="date"
          value={spendDate}
          onChange={(e) => setSpendDate(e.target.value)}
          className="h-9"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Расход</Label>
        <Input
          inputMode="decimal"
          value={spend}
          onChange={(e) => setSpend(e.target.value)}
          placeholder="0"
          className="h-9"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Показы</Label>
        <Input
          inputMode="numeric"
          value={impressions}
          onChange={(e) => setImpressions(e.target.value)}
          placeholder="0"
          className="h-9"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Клики</Label>
        <Input
          inputMode="numeric"
          value={clicks}
          onChange={(e) => setClicks(e.target.value)}
          placeholder="0"
          className="h-9"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Лиды</Label>
        <Input
          inputMode="numeric"
          value={leads}
          onChange={(e) => setLeads(e.target.value)}
          placeholder="0"
          className="h-9"
        />
      </div>
      <div className="col-span-2 flex justify-end sm:col-span-3">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          Сохранить день
        </Button>
      </div>
    </div>
  )
}

function SpendRow({
  row,
  sourceId,
  currency,
  onChanged,
}: {
  row: SourceSpendDay
  sourceId: string
  currency: string
  onChanged: () => void
}) {
  const [pending, startTransition] = useTransition()

  function remove() {
    startTransition(async () => {
      try {
        await deleteSpendDayAction({ id: row.id, sourceId })
        onChanged()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось удалить.')
      }
    })
  }

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2 tabular-nums">
        {row.spendDate.split('-').reverse().join('.')}
      </td>
      <td className="px-3 py-2 text-right font-medium tabular-nums">
        {formatMoney(row.spend, currency)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {row.impressions.toLocaleString('ru-RU')}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {row.clicks.toLocaleString('ru-RU')}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {row.leads.toLocaleString('ru-RU')}
      </td>
      <td className="px-1">
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          className="text-muted-foreground transition-colors hover:text-destructive"
          aria-label="Удалить день"
        >
          <X className="size-4" />
        </button>
      </td>
    </tr>
  )
}
