'use client'

import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Единый переключатель периода на весь проект. Горизонтально-скроллящаяся
 * лента чипов-пресетов + инлайновые нативные date-инпуты для режимов «День»
 * (один инпут) и «Период» (два инпута). Полностью презентационный: всё
 * состояние живёт в контейнере и приходит через пропсы.
 *
 * Один общий компонент для Обзора (админ/менеджер) и списков лидов
 * (админ/менеджер). Раньше Обзор открывал даты во всплывающем поповере
 * («С / По / Показать период») — теперь везде одинаковый инлайновый вид.
 *
 * Дженерик по ключу пресета `K`: каждый экран передаёт свой набор пресетов
 * (у лидов есть «Всё время»/«День», у Обзора — «Вчера»/«90 дней»), сохраняя
 * строгую типизацию без приведений. Инлайновые инпуты показываются для
 * зарезервированных ключей `'day'` и `'range'`.
 */
export function PeriodFilter<K extends string>({
  presets,
  preset,
  day,
  from,
  to,
  today,
  onPreset,
  onDay,
  onFrom,
  onTo,
  trailing,
  className,
}: {
  presets: readonly { key: K; label: string }[]
  preset: K
  /** YYYY-MM-DD, для режима 'day'. */
  day?: string
  /** YYYY-MM-DD, начало режима 'range'. */
  from?: string
  /** YYYY-MM-DD, конец режима 'range'. */
  to?: string
  /** Верхняя граница выбора (обычно сегодня, YYYY-MM-DD). */
  today: string
  onPreset: (key: K) => void
  onDay?: (day: string) => void
  onFrom?: (from: string) => void
  onTo?: (to: string) => void
  /** Доп. контент в том же ряду справа (подпись периода, фильтры, экспорт). */
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {/* На узких экранах лента пресетов уходит в горизонтальный скролл,
          не ломая перенос остального ряда. */}
      <div className="scrollbar-thin -mx-1 max-w-full overflow-x-auto px-1 sm:mx-0 sm:px-0">
        <div
          role="group"
          aria-label="Период"
          className="flex h-9 w-max items-center gap-1 rounded-lg border border-border bg-muted/30 p-1"
        >
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => onPreset(p.key)}
              aria-pressed={preset === p.key}
              className={cn(
                'flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm transition-colors',
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
          value={day ?? today}
          max={today}
          onChange={(e) => onDay?.(e.target.value || today)}
          className="h-9 w-full sm:w-40"
          aria-label="Выбрать день"
        />
      ) : null}

      {preset === 'range' ? (
        <div className="flex w-full items-center gap-1.5 sm:w-auto">
          <Input
            type="date"
            value={from ?? today}
            max={to ?? today}
            onChange={(e) => onFrom?.(e.target.value || from || today)}
            className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none"
            aria-label="Начало периода"
          />
          <span className="shrink-0 text-sm text-muted-foreground">—</span>
          <Input
            type="date"
            value={to ?? today}
            max={today}
            onChange={(e) => onTo?.(e.target.value || to || today)}
            className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none"
            aria-label="Конец периода"
          />
        </div>
      ) : null}

      {trailing}
    </div>
  )
}
