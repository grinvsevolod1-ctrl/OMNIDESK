'use client'

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Character counter for textareas.
 *
 * - `min` mode: the field requires at least N characters. Shows a progress
 *   bar toward the minimum and "ещё N символов" hint; flips to a green check
 *   once satisfied. Never reads as "limit 30" the way a raw `0/30` does.
 * - `max` mode: the field is capped at N characters. Shows remaining count,
 *   turning amber near the limit and red at it.
 */
export function CharCounter({
  value,
  min,
  max,
  className,
}: {
  value: string
  min?: number
  max?: number
  className?: string
}) {
  const len = value.trim().length

  if (min && min > 0) {
    const left = Math.max(0, min - len)
    const pct = Math.min(100, Math.round((len / min) * 100))
    const done = left === 0
    return (
      <div
        className={cn('flex items-center gap-2', className)}
        aria-live="polite"
      >
        <div
          className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Заполнено ${pct}% минимальной длины`}
        >
          <div
            className={cn(
              'h-full rounded-full transition-all duration-300',
              done ? 'bg-success' : 'bg-primary',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        {done ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-success">
            <Check className="size-3" />
            Достаточно
          </span>
        ) : (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {'ещё '}
            {left}
            {' симв. (мин. '}
            {min}
            {')'}
          </span>
        )}
      </div>
    )
  }

  if (max && max > 0) {
    const raw = value.length
    const left = max - raw
    return (
      <span
        className={cn(
          'text-[11px] tabular-nums transition-colors',
          left < 0
            ? 'font-medium text-destructive'
            : left <= Math.max(5, Math.round(max * 0.1))
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground',
          className,
        )}
        aria-live="polite"
      >
        {raw}/{max}
      </span>
    )
  }

  return null
}
