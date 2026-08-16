'use client'

import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Дельта «к прошлому периоду»: +12% зелёным / −8% красным / «—» когда
 * прошлый период пуст (рост из нуля не выражается процентом честно).
 * invert — для метрик, где рост это плохо (расход).
 */
export function DeltaBadge({
  current,
  prev,
  invert = false,
  className,
}: {
  current: number
  prev: number | undefined
  invert?: boolean
  className?: string
}) {
  if (prev === undefined) return null
  if (prev === 0) {
    if (current === 0) return null
    return (
      <span
        className={cn('text-[11px] font-medium text-muted-foreground', className)}
        title="Прошлый период: 0"
      >
        новое
      </span>
    )
  }
  const pct = Math.round(((current - prev) / prev) * 100)
  if (pct === 0) {
    return (
      <span
        className={cn('text-[11px] font-medium text-muted-foreground', className)}
        title={`Прошлый период: ${prev}`}
      >
        0%
      </span>
    )
  }
  const up = pct > 0
  const good = invert ? !up : up
  const Icon = up ? ArrowUpRight : ArrowDownRight
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums',
        good ? 'text-success' : 'text-destructive',
        className,
      )}
      title={`Прошлый период: ${prev}`}
    >
      <Icon className="size-3" aria-hidden />
      {up ? '+' : ''}
      {pct}%
    </span>
  )
}
