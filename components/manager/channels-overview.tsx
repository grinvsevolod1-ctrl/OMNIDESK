'use client'

import { createElement, memo } from 'react'
import Link from 'next/link'
import { LayoutGrid, Plug, Plus, Rows3 } from 'lucide-react'
import useSWR from 'swr'
import { getManagerChannelsOverviewAction } from '@/app/actions/manager-analytics'
import { channelIcon } from '@/components/channel-icons'
import {
  PeriodPicker,
  resolvePeriod,
} from '@/components/admin/overview/period-picker'
import { DeltaBadge } from '@/components/admin/overview/delta-badge'
import { useManagerOverviewPrefs } from '@/components/admin/overview/use-overview-prefs'
import { EmptyState, StatusBadge } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import type { ManagerChannelOverviewItem } from '@/lib/data/analytics-groups'
import { getChannelMeta } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Спарклайн «люди по дням» (чистый SVG, как в админском Обзоре). */
function Sparkline({
  values,
  className,
}: {
  values: number[]
  className?: string
}) {
  const w = 96
  const h = 28
  if (values.length < 2) {
    return <div className={cn('h-7 w-24', className)} aria-hidden />
  }
  const max = Math.max(...values, 1)
  const step = w / (values.length - 1)
  const pts = values.map(
    (v, i) =>
      `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`,
  )
  const line = `M${pts.join(' L')}`
  const area = `${line} L${w},${h} L0,${h} Z`
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn('h-7 w-24 shrink-0 text-primary/70', className)}
      aria-hidden
    >
      <path d={area} fill="currentColor" opacity="0.12" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

type Variant = 'hero' | 'wide' | 'compact'

/** Голая бренд-иконка канала (без подложек) через createElement — иконка
    выбирается по типу в рантайме, компонент при этом не создаётся заново. */
function ChannelGlyph({
  type,
  className,
}: {
  type: ManagerChannelOverviewItem['type']
  className?: string
}) {
  return createElement(channelIcon(type), { className })
}

const ChannelCard = memo(function ChannelCard({
  item,
  prevPeople,
  variant,
}: {
  item: ManagerChannelOverviewItem
  prevPeople?: number
  variant: Variant
}) {
  const meta = getChannelMeta(item.type)

  if (variant === 'hero') {
    return (
      <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ChannelGlyph type={item.type} className="size-10 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{item.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {meta.label}
                {item.detail ? ` · ${item.detail}` : ''}
              </p>
            </div>
          </div>
          <StatusBadge status={item.status} />
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
          <div>
            <p className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tabular-nums">
                {item.people}
              </span>
              <DeltaBadge current={item.people} prev={prevPeople} />
            </p>
            <p className="text-[11px] text-muted-foreground">людей написало</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">
              {item.transferred}
            </p>
            <p className="text-[11px] text-muted-foreground">передано</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">
              {item.people > 0
                ? `${Math.round((item.transferred / item.people) * 100)}%`
                : '—'}
            </p>
            <p className="text-[11px] text-muted-foreground">конверсия</p>
          </div>
        </div>

        <Sparkline values={item.spark} className="h-12 w-full" />
      </div>
    )
  }

  if (variant === 'wide') {
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <ChannelGlyph type={item.type} className="size-8 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{item.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {meta.label}
              </p>
            </div>
          </div>
          <StatusBadge status={item.status} />
        </div>

        <div className="flex items-baseline gap-5">
          <div>
            <p className="flex items-baseline gap-1.5">
              <span className="text-xl font-semibold tabular-nums">
                {item.people}
              </span>
              <DeltaBadge current={item.people} prev={prevPeople} />
            </p>
            <p className="text-[11px] text-muted-foreground">людей</p>
          </div>
          <div>
            <p className="text-xl font-semibold tabular-nums">
              {item.transferred}
            </p>
            <p className="text-[11px] text-muted-foreground">передано</p>
          </div>
        </div>

        <Sparkline values={item.spark} className="h-9 w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ChannelGlyph type={item.type} className="size-7 shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{item.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {meta.label}
            </p>
          </div>
        </div>
        <Sparkline values={item.spark} />
      </div>
      <dl className="flex items-baseline gap-4">
        <div>
          <dt className="sr-only">Написало людей</dt>
          <dd className="flex items-baseline gap-1.5">
            <span className="text-xl font-semibold tabular-nums">
              {item.people}
            </span>
            <DeltaBadge current={item.people} prev={prevPeople} />
          </dd>
          <dd className="text-[11px] text-muted-foreground">людей</dd>
        </div>
        <div>
          <dt className="sr-only">Передано</dt>
          <dd className="text-xl font-semibold tabular-nums">
            {item.transferred}
          </dd>
          <dd className="text-[11px] text-muted-foreground">передано</dd>
        </div>
        <div className="ml-auto">
          <StatusBadge status={item.status} />
        </div>
      </dl>
    </div>
  )
})

function ChannelRow({
  item,
  prevPeople,
}: {
  item: ManagerChannelOverviewItem
  prevPeople?: number
}) {
  return (
    <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1.4fr)_5rem_4.5rem_4.5rem_auto]">
      <span className="flex min-w-0 items-center gap-2.5">
        <ChannelGlyph type={item.type} className="size-6 shrink-0" />
        <span className="truncate text-sm font-medium">{item.name}</span>
      </span>

      <span className="hidden sm:block">
        <Sparkline values={item.spark} className="h-5 w-20" />
      </span>

      <span className="hidden items-baseline gap-1 tabular-nums sm:flex">
        <span className="text-sm font-semibold">{item.people}</span>
        <DeltaBadge current={item.people} prev={prevPeople} />
      </span>

      <span className="hidden text-sm tabular-nums text-muted-foreground sm:block">
        {item.transferred}
      </span>

      <span className="justify-self-end">
        <StatusBadge status={item.status} />
      </span>

      {/* Мобильная сводка */}
      <span className="col-span-2 flex items-center gap-3 text-xs text-muted-foreground sm:hidden">
        <span className="flex items-baseline gap-1">
          <span className="font-semibold text-foreground tabular-nums">
            {item.people}
          </span>
          людей
        </span>
        <span>{item.transferred} передано</span>
      </span>
    </div>
  )
}

/**
 * Обзор каналов менеджера — его логическая цепочка: канал → сколько людей
 * написало → сколько передано. Период и вид (карточки/список) сохраняются
 * между заходами; плотность карточек зависит от числа каналов, как в
 * админском Обзоре. Денег здесь нет — финансы видит только администратор.
 */
export function ChannelsOverview() {
  const [prefs, setPrefs] = useManagerOverviewPrefs()
  const resolved = resolvePeriod(prefs.preset, prefs.customFrom, prefs.customTo)
  const fromISO = resolved.from.toISOString()
  const toISO = resolved.to.toISOString()

  const { data: payload, isLoading } = useSWR(
    ['manager-channels-overview', fromISO, toISO],
    async () => {
      const tz = new Date().getTimezoneOffset()
      const res = await getManagerChannelsOverviewAction(fromISO, toISO, tz)
      if (!res.ok || !res.data) throw new Error(res.message)
      return { overview: res.data, prev: res.prev }
    },
    { keepPreviousData: true },
  )

  const items = payload?.overview.items ?? []
  const prev = payload?.prev

  const variant: Variant =
    items.length === 1 ? 'hero' : items.length <= 3 ? 'wide' : 'compact'

  return (
    <section className="flex flex-col gap-3">
      {/* Шапка: заголовок + период + вид */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Ваши каналы
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodPicker
            preset={prefs.preset}
            customFrom={prefs.customFrom}
            customTo={prefs.customTo}
            resolved={resolved}
            onChange={(patch) => setPrefs(patch)}
          />
          <div
            role="group"
            aria-label="Вид"
            className="flex items-center rounded-lg border border-border p-0.5"
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPrefs({ view: 'cards' })}
              className={cn(
                'h-7 rounded-md px-2',
                prefs.view === 'cards'
                  ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground'
                  : 'text-muted-foreground',
              )}
              aria-pressed={prefs.view === 'cards'}
              aria-label="Карточками"
            >
              <LayoutGrid className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPrefs({ view: 'list' })}
              className={cn(
                'h-7 rounded-md px-2',
                prefs.view === 'list'
                  ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground'
                  : 'text-muted-foreground',
              )}
              aria-pressed={prefs.view === 'list'}
              aria-label="Списком"
            >
              <Rows3 className="size-3.5" />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            render={<Link href="/app/connections">Управление</Link>}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5">
          {isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Загрузка…
            </p>
          ) : (
            <EmptyState
              icon={Plug}
              title="Каналов пока нет"
              description="Подключите Telegram, WhatsApp или виджет живого чата на сайте, чтобы начать получать сообщения."
              action={
                <Button
                  render={
                    <Link href="/app/connections">
                      <Plus className="size-4" />
                      Добавить первый канал
                    </Link>
                  }
                />
              }
            />
          )}
        </div>
      ) : prefs.view === 'list' ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="hidden grid-cols-[minmax(0,1.4fr)_5rem_4.5rem_4.5rem_auto] gap-x-4 border-b border-border px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground sm:grid">
            <span>Канал</span>
            <span>Динамика</span>
            <span>Людей</span>
            <span>Передано</span>
            <span className="justify-self-end">Статус</span>
          </div>
          <div className="divide-y divide-border">
            {items.map((item) => (
              <ChannelRow
                key={item.id}
                item={item}
                prevPeople={prev?.[item.id]?.people}
              />
            ))}
          </div>
        </div>
      ) : (
        <div
          className={cn(
            'grid gap-3',
            variant === 'hero'
              ? 'grid-cols-1'
              : variant === 'wide'
                ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
                : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
          )}
        >
          {items.map((item) => (
            <ChannelCard
              key={item.id}
              item={item}
              prevPeople={prev?.[item.id]?.people}
              variant={variant}
            />
          ))}
        </div>
      )}
    </section>
  )
}
