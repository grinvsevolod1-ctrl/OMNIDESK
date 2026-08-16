'use client'

import { memo } from 'react'
import { ChevronRight } from 'lucide-react'
import { typeDot } from '@/components/admin/dashboard/source-groups/shared'
import { DeltaBadge } from './delta-badge'
import { cn } from '@/lib/utils'
import type { SourceOverviewItem } from '@/lib/data/sources'

function formatMoney(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${Math.round(v / 1000)}K`
  return v % 1 === 0 ? String(v) : v.toFixed(2)
}

/** Мини-спарклайн для строки списка. */
function RowSpark({ values }: { values: number[] }) {
  const w = 80
  const h = 20
  if (values.length < 2) return <div className="h-5 w-20" aria-hidden />
  const max = Math.max(...values, 1)
  const step = w / (values.length - 1)
  const pts = values.map(
    (v, i) =>
      `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`,
  )
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-5 w-20 shrink-0 text-primary/70"
      aria-hidden
    >
      <path
        d={`M${pts.join(' L')}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}

const Row = memo(function Row({
  item,
  active,
  onSelect,
  prevPeople,
}: {
  item: SourceOverviewItem
  active: boolean
  onSelect: (id: string) => void
  prevPeople?: number
}) {
  const { stats } = item
  const types = [...new Set(item.channels.map((c) => c.type))]
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-pressed={active}
      className={cn(
        'group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors sm:grid-cols-[minmax(0,1.4fr)_5rem_4.5rem_4.5rem_5rem_1rem]',
        active ? 'bg-primary/5' : 'hover:bg-muted/40',
      )}
    >
      {/* Имя + каналы */}
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 items-center gap-1">
          {types.map((t) => (
            <span
              key={t}
              className={cn('size-2 rounded-full', typeDot(t))}
              aria-hidden
            />
          ))}
        </span>
        <span className="truncate text-sm font-medium">{item.name}</span>
        {item.channels.length > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {item.channels.length}
          </span>
        ) : null}
      </span>

      {/* Спарклайн — только на широких экранах */}
      <span className="hidden sm:block">
        <RowSpark values={stats.spark} />
      </span>

      <span className="hidden items-baseline gap-1 tabular-nums sm:flex">
        <span className="text-sm font-semibold">{stats.people}</span>
        <DeltaBadge current={stats.people} prev={prevPeople} />
      </span>

      <span className="hidden text-sm tabular-nums text-muted-foreground sm:block">
        {stats.transferred}
      </span>

      <span className="hidden text-sm tabular-nums text-muted-foreground sm:block">
        {stats.expense > 0 ? `−${formatMoney(stats.expense)}` : '—'}
      </span>

      {/* Мобильная сводка одной строкой */}
      <span className="col-span-2 flex items-center gap-3 text-xs text-muted-foreground sm:hidden">
        <span className="flex items-baseline gap-1">
          <span className="font-semibold text-foreground tabular-nums">
            {stats.people}
          </span>
          людей
        </span>
        <span>{stats.transferred} передано</span>
        <span>
          {stats.expense > 0 ? `−${formatMoney(stats.expense)} расход` : ''}
        </span>
      </span>

      <ChevronRight
        className="hidden size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 sm:block"
        aria-hidden
      />
    </button>
  )
})

/**
 * Список источников — плотная альтернатива карточкам для десятков источников.
 * Те же данные и то же поведение (клик открывает панель деталей).
 */
export function SourceList({
  items,
  activeId,
  onSelect,
  prev,
}: {
  items: SourceOverviewItem[]
  activeId: string | null
  onSelect: (id: string) => void
  prev?: Record<string, { people: number }>
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {/* Шапка колонок (desktop) */}
      <div className="hidden grid-cols-[minmax(0,1.4fr)_5rem_4.5rem_4.5rem_5rem_1rem] gap-x-4 border-b border-border px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground sm:grid">
        <span>Источник</span>
        <span>Динамика</span>
        <span>Людей</span>
        <span>Передано</span>
        <span>Расход</span>
        <span />
      </div>
      <div className="divide-y divide-border">
        {items.map((item) => (
          <Row
            key={item.id}
            item={item}
            active={item.id === activeId}
            onSelect={onSelect}
            prevPeople={prev?.[item.id]?.people}
          />
        ))}
      </div>
    </div>
  )
}
