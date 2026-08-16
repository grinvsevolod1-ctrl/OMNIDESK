'use client'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { PeriodPreset } from './period-range'

const PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: 'all', label: 'Всё время' },
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: 'day', label: 'День' },
  { key: 'range', label: 'Период' },
]

/**
 * Пресеты периода (Всё время / Сегодня / 7 / 30 дней / День / Период)
 * плюс инпуты дат для режимов «День» и «Период». Презентационный: всё
 * состояние живёт в контейнере, сюда приходит через пропсы.
 */
export function LeadsPeriodFilter({
  preset,
  day,
  from,
  to,
  today,
  onPreset,
  onDay,
  onFrom,
  onTo,
}: {
  preset: PeriodPreset
  day: string
  from: string
  to: string
  today: string
  onPreset: (preset: PeriodPreset) => void
  onDay: (day: string) => void
  onFrom: (from: string) => void
  onTo: (to: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* На узких экранах пресеты уходят в горизонтальный скролл */}
      <div className="scrollbar-thin -mx-1 max-w-full overflow-x-auto px-1 sm:mx-0 sm:px-0">
        <div className="flex w-max items-center gap-1 rounded-xl border border-border bg-muted/30 p-1">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => onPreset(p.key)}
              className={cn(
                'shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors',
                preset === p.key
                  ? 'bg-background font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {preset === 'day' ? (
        <Input
          type="date"
          value={day}
          max={today}
          onChange={(e) => onDay(e.target.value || today)}
          className="h-9 w-40"
          aria-label="Выбрать день"
        />
      ) : null}

      {preset === 'range' ? (
        <div className="flex w-full items-center gap-1.5 sm:w-auto">
          <Input
            type="date"
            value={from}
            max={to}
            onChange={(e) => onFrom(e.target.value || from)}
            className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none"
            aria-label="Начало периода"
          />
          <span className="shrink-0 text-sm text-muted-foreground">—</span>
          <Input
            type="date"
            value={to}
            max={today}
            onChange={(e) => onTo(e.target.value || to)}
            className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none"
            aria-label="Конец периода"
          />
        </div>
      ) : null}
    </div>
  )
}
