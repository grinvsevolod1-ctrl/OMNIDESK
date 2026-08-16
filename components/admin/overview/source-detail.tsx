'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { Loader2, Pencil, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteSourceAction,
  getSourceDetailAction,
  renameSourceAction,
} from '@/app/actions/sources'
import { Report } from '@/components/admin/dashboard/source-groups/group-report'
import { typeDot } from '@/components/admin/dashboard/source-groups/shared'
import { useChannelTypeLabels } from '@/components/dictionaries-provider'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { SourceDetail as SourceDetailData } from '@/lib/data/sources'
import { cn } from '@/lib/utils'

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

function money(v: number, currency: string): string {
  const n = v % 1 === 0 ? v.toLocaleString('ru-RU') : v.toFixed(2)
  return `${n} ${currency === 'RUB' ? '₽' : currency}`
}

/** Ступень воронки: значение, подпись и конверсия от предыдущей ступени. */
function FunnelStep({
  label,
  value,
  conversion,
  last,
}: {
  label: string
  value: number
  conversion?: string
  last?: boolean
}) {
  return (
    <div className="relative flex-1 min-w-32 rounded-lg border border-border bg-card p-3">
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {conversion ? (
        <p className="mt-1 text-[11px] font-medium text-primary/80">
          {conversion}
        </p>
      ) : null}
      {!last ? (
        <span
          className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 text-muted-foreground/50 sm:block"
          aria-hidden
        >
          →
        </span>
      ) : null}
    </div>
  )
}

/**
 * Нижняя панель Обзора: всё об источнике — воронка лидов, деньги и трафик.
 * Данные тянутся клиентски (SWR), чтобы смена источника/периода была мгновенной.
 */
export function SourceDetail({
  sourceId,
  fromISO,
  toISO,
  onClose,
}: {
  sourceId: string
  fromISO: string
  toISO: string
  onClose: () => void
}) {
  const TYPE_LABEL = useChannelTypeLabels()
  const router = useRouter()
  const [renameOpen, setRenameOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [pending, startTransition] = useTransition()

  const { data, isValidating } = useSWR(
    ['source-detail', sourceId, fromISO, toISO],
    async () => {
      const tz = new Date().getTimezoneOffset()
      const res = await getSourceDetailAction(sourceId, fromISO, toISO, tz)
      if (!res.ok) throw new Error(res.message)
      return res.data ?? null
    },
    { keepPreviousData: true, revalidateOnFocus: false },
  )

  function submitRename() {
    startTransition(async () => {
      const res = await renameSourceAction(sourceId, newName)
      if (res.ok) {
        toast.success(res.message)
        setRenameOpen(false)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  function remove() {
    const ok = window.confirm(
      'Удалить источник целиком?\n\nВместе с ним из «Учёта» удалятся все финансовые данные этого источника. Это действие необратимо.',
    )
    if (!ok) return
    startTransition(async () => {
      const res = await deleteSourceAction(sourceId)
      if (res.ok) {
        toast.success(res.message)
        onClose()
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  if (!data) {
    return (
      <Card className="flex h-48 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Загрузка деталей источника</span>
      </Card>
    )
  }

  return (
    <Card className={cn('flex flex-col gap-5 p-5', isValidating && 'opacity-80')}>
      {/* Шапка: имя, каналы, действия */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{data.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {data.channels.length > 0 ? (
              data.channels.map((c) => (
                <span
                  key={c.id}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <span
                    className={cn('size-2 rounded-full', typeDot(c.type))}
                    aria-hidden
                  />
                  {TYPE_LABEL[c.type]}: {c.name}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">
                Каналы не привязаны — добавьте их через «Управление источниками»
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setNewName(data.name)
              setRenameOpen(true)
            }}
          >
            <Pencil className="size-3.5" />
            Переименовать
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={remove}
            disabled={pending}
          >
            <Trash2 className="size-3.5" />
            Удалить
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Закрыть детали"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Воронка лидов */}
      <section aria-label="Воронка лидов">
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">
          Воронка за период
        </h3>
        <div className="flex flex-wrap gap-3 sm:gap-5">
          <FunnelStep label="Написали" value={data.funnel.people} />
          <FunnelStep
            label="Передан человеку"
            value={data.funnel.handoff}
            conversion={pct(data.funnel.handoff, data.funnel.people)}
          />
          <FunnelStep
            label="Ликвид"
            value={data.funnel.liquid}
            conversion={pct(data.funnel.liquid, data.funnel.handoff)}
          />
          <FunnelStep
            label="Передан"
            value={data.funnel.transferred}
            conversion={pct(data.funnel.transferred, data.funnel.liquid)}
            last
          />
        </div>
      </section>

      {/* Деньги */}
      <section aria-label="Финансы источника">
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">
          Деньги{' '}
          <span className="font-normal">
            (то же, что во вкладке «Учёт» — это один источник)
          </span>
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border p-3">
            <p className="text-lg font-semibold tabular-nums text-success">
              +{money(data.finance.income, data.finance.currency)}
            </p>
            <p className="text-xs text-muted-foreground">Пополнено за период</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-lg font-semibold tabular-nums">
              −{money(data.finance.expense, data.finance.currency)}
            </p>
            <p className="text-xs text-muted-foreground">Потрачено за период</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p
              className={cn(
                'text-lg font-semibold tabular-nums',
                data.finance.balanceAllTime < 0 && 'text-destructive',
              )}
            >
              {money(data.finance.balanceAllTime, data.finance.currency)}
            </p>
            <p className="text-xs text-muted-foreground">Баланс за всё время</p>
          </div>
        </div>
        {data.funnel.transferred > 0 && data.finance.expense > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Стоимость переданного лида:{' '}
            <span className="font-medium text-foreground">
              {money(
                Math.round(
                  (data.finance.expense / data.funnel.transferred) * 100,
                ) / 100,
                data.finance.currency,
              )}
            </span>
          </p>
        ) : null}
      </section>

      {/* Трафик — переиспользуем готовый отчёт (граф по дням, каналы, типы) */}
      <section aria-label="Трафик источника">
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">Трафик</h3>
        <Report analytics={data.traffic} />
      </section>

      {/* Диалог переименования */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="w-[min(420px,94vw)]">
          <DialogHeader>
            <DialogTitle>Переименовать источник</DialogTitle>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Название источника"
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              )
                submitRename()
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Отмена
            </Button>
            <Button onClick={submitRename} disabled={pending || !newName.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Сохранить
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** Упрощённая панель для системной карточки «Без источника». */
export function UnassignedDetail({
  channels,
  onClose,
}: {
  channels: { id: string; name: string; type: Parameters<typeof typeDot>[0] }[]
  onClose: () => void
}) {
  const TYPE_LABEL = useChannelTypeLabels()
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Без источника</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Эти каналы не привязаны ни к одному источнику. Добавьте их в источник
            через «Управление источниками», чтобы видеть по ним полную сводку.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Закрыть детали"
        >
          <X className="size-4" />
        </Button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {channels.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-sm">
            <span className={cn('size-2 rounded-full', typeDot(c.type))} aria-hidden />
            <span className="text-muted-foreground">{TYPE_LABEL[c.type]}:</span>
            {c.name}
          </li>
        ))}
      </ul>
    </Card>
  )
}
