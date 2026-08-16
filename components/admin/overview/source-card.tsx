'use client'

import { memo } from 'react'
import { typeDot } from '@/components/admin/dashboard/source-groups/shared'
import { cn } from '@/lib/utils'
import type { SourceOverviewItem } from '@/lib/data/sources'

/** Компактный спарклайн «люди по дням» (чистый SVG, без библиотек). */
function Sparkline({ values }: { values: number[] }) {
  const w = 96
  const h = 28
  if (values.length < 2) {
    return <div className="h-7 w-24" aria-hidden />
  }
  const max = Math.max(...values, 1)
  const step = w / (values.length - 1)
  const pts = values.map(
    (v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`,
  )
  const line = `M${pts.join(' L')}`
  const area = `${line} L${w},${h} L0,${h} Z`
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-7 w-24 shrink-0 text-primary/70"
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

export const SourceCard = memo(function SourceCard({
  item,
  active,
  onSelect,
}: {
  item: SourceOverviewItem
  active: boolean
  onSelect: (id: string) => void
}) {
  const { stats } = item
  // Уникальные типы каналов источника — цветные точки в шапке карточки.
  const types = [...new Set(item.channels.map((c) => c.type))]
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-pressed={active}
      className={cn(
        'group flex flex-col gap-3 rounded-xl border p-4 text-left transition-all',
        active
          ? 'border-primary bg-primary/5 shadow-sm'
          : 'border-border bg-card hover:border-muted-foreground/30 hover:shadow-sm',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{item.name}</p>
          <div className="mt-1 flex items-center gap-1">
            {types.length > 0 ? (
              types.map((t) => (
                <span
                  key={t}
                  className={cn('size-2 rounded-full', typeDot(t))}
                  aria-hidden
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
        </div>
        <Sparkline values={stats.spark} />
      </div>

      <dl className="flex items-baseline gap-4">
        <div>
          <dt className="sr-only">Написало людей</dt>
          <dd className="text-xl font-semibold tabular-nums">{stats.people}</dd>
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
