'use client'

import { memo } from 'react'
import { ChevronRight } from 'lucide-react'
import { ChannelIcon } from '@/components/channel-icons'
import { DeltaBadge } from './delta-badge'
import { cn } from '@/lib/utils'
import type { SourceOverviewItem } from '@/lib/data/sources'

/**
 * Плотность карточки зависит от числа источников на экране:
 * hero — единственный источник, вся статистика сразу;
 * wide — 2-3 источника, расширенный набор цифр;
 * compact — плотная сетка для многих источников.
 */
export type CardVariant = 'hero' | 'wide' | 'compact'

/** Компактный спарклайн «люди по дням» (чистый SVG, без библиотек). */
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

function formatMoney(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${Math.round(v / 1000)}K`
  return v % 1 === 0 ? String(v) : v.toFixed(2)
}

function Stat({
  label,
  value,
  delta,
  big,
}: {
  label: string
  value: string | number
  delta?: { current: number; prev?: number }
  big?: boolean
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-baseline gap-1.5">
        <span
          className={cn(
            'font-semibold tabular-nums',
            big ? 'text-2xl' : 'text-xl',
          )}
        >
          {value}
        </span>
        {delta ? <DeltaBadge current={delta.current} prev={delta.prev} /> : null}
      </p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
}

/** Иконки мессенджеров источника + число привязанных каналов. */
function ChannelDots({ item }: { item: SourceOverviewItem }) {
  const types = [...new Set(item.channels.map((c) => c.type))]
  return (
    <div className="flex items-center gap-1">
      {types.length > 0 ? (
        types.map((t) => (
          <ChannelIcon
            key={t}
            type={t}
            className="size-3.5 text-muted-foreground"
          />
        ))
      ) : (
        <span className="text-xs text-muted-foreground">Нет каналов</span>
      )}
      {item.channels.length > 0 ? (
        <span className="ml-1 text-xs text-muted-foreground">
          {item.channels.length}
        </span>
      ) : null}
    </div>
  )
}

export const SourceCard = memo(function SourceCard({
  item,
  active,
  onSelect,
  prevPeople,
  variant = 'compact',
}: {
  item: SourceOverviewItem
  active: boolean
  onSelect: (id: string) => void
  /** Люди за прошлый период (для дельты); undefined — дельту не показывать. */
  prevPeople?: number
  variant?: CardVariant
}) {
  const { stats } = item
  const base = cn(
    'group flex flex-col rounded-xl border text-left transition-all',
    active
      ? 'border-primary bg-primary/5 shadow-sm'
      : 'border-border bg-card hover:border-muted-foreground/30 hover:shadow-sm',
  )

  if (variant === 'hero') {
    return (
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        aria-pressed={active}
        className={cn(base, 'gap-5 p-5 sm:p-6')}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{item.name}</p>
            <div className="mt-1.5">
              <ChannelDots item={item} />
            </div>
          </div>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            Детали
            <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat
            big
            label="людей написало"
            value={stats.people}
            delta={{ current: stats.people, prev: prevPeople }}
          />
          <Stat big label="взяли в работу" value={stats.handoff} />
          <Stat big label="ликвид" value={stats.liquid} />
          <Stat big label="передано" value={stats.transferred} />
          <Stat
            big
            label="пополнено"
            value={stats.income > 0 ? `+${formatMoney(stats.income)}` : '—'}
          />
          <Stat
            big
            label="расход"
            value={stats.expense > 0 ? `−${formatMoney(stats.expense)}` : '—'}
          />
        </div>

        <Sparkline values={stats.spark} className="h-12 w-full" />
      </button>
    )
  }

  if (variant === 'wide') {
    return (
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        aria-pressed={active}
        className={cn(base, 'gap-4 p-5')}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">{item.name}</p>
            <div className="mt-1">
              <ChannelDots item={item} />
            </div>
          </div>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            Детали
            <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
          <Stat
            label="людей"
            value={stats.people}
            delta={{ current: stats.people, prev: prevPeople }}
          />
          <Stat label="ликвид" value={stats.liquid} />
          <Stat label="передано" value={stats.transferred} />
          <Stat
            label="расход"
            value={stats.expense > 0 ? `−${formatMoney(stats.expense)}` : '—'}
          />
        </div>

        <Sparkline values={stats.spark} className="h-9 w-full" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-pressed={active}
      className={cn(base, 'gap-3 p-4')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{item.name}</p>
          <div className="mt-1">
            <ChannelDots item={item} />
          </div>
        </div>
        <Sparkline values={stats.spark} />
      </div>

      <dl className="flex items-baseline gap-4">
        <div>
          <dt className="sr-only">Написало людей</dt>
          <dd className="flex items-baseline gap-1.5">
            <span className="text-xl font-semibold tabular-nums">
              {stats.people}
            </span>
            <DeltaBadge current={stats.people} prev={prevPeople} />
          </dd>
          <dd className="text-[11px] text-muted-foreground">людей</dd>
        </div>
        <div>
          <dt className="sr-only">Передано лидов</dt>
          <dd className="text-xl font-semibold tabular-nums">
            {stats.transferred}
          </dd>
          <dd className="text-[11px] text-muted-foreground">передано</dd>
        </div>
        <div className="ml-auto text-right">
          <dt className="sr-only">Расход за период</dt>
          <dd className="text-sm font-medium tabular-nums text-muted-foreground">
            {stats.expense > 0 ? `−${formatMoney(stats.expense)}` : '—'}
          </dd>
          <dd className="text-[11px] text-muted-foreground">расход</dd>
        </div>
      </dl>
    </button>
  )
})
