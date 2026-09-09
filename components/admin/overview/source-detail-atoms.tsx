'use client'

/**
 * Презентационные атомы отчёта источника: мини-плитки метрик, числа в шапке
 * графика, переключатель сегмента и загрузочные/пустые состояния графика.
 * Без данных и без сайд-эффектов — чистый UI, вынесены из source-detail-dialog.
 */

import { Loader2, type MessageSquare } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type Segment = 'wrote' | 'transferred' | 'working'

/* ------------------------------ Мини-плитка ------------------------------ */

export function MiniStat({
  icon: Icon,
  label,
  value,
  tone = 'default',
  hint,
  loading,
}: {
  icon: typeof MessageSquare
  label: string
  value: number | string
  tone?: 'default' | 'primary' | 'success' | 'info' | 'warning'
  hint?: string
  loading?: boolean
}) {
  const toneCls = {
    default: 'text-foreground',
    primary: 'text-primary',
    success: 'text-success',
    info: 'text-sky-600 dark:text-sky-400',
    warning: 'text-warning',
  }[tone]
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className={cn('size-3.5', tone === 'default' ? '' : toneCls)} />
        {label}
      </span>
      {loading ? (
        <span className="h-8 w-16 animate-pulse rounded bg-muted" />
      ) : (
        <span className={cn('text-2xl font-semibold tabular-nums', toneCls)}>
          {value}
        </span>
      )}
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </Card>
  )
}

/* --------------------------- Число в шапке графика --------------------------- */

export function SummaryNum({
  label,
  value,
}: {
  label: string
  value: number | string
}) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold tabular-nums leading-none">
        {value}
      </span>
      <span className="mt-1 text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

export function SpendNum({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  )
}

/* --------------------------- Переключатель сегмента --------------------------- */

export function SegBtn({
  active,
  onClick,
  icon: Icon,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  icon: typeof MessageSquare
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-center transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="flex items-center gap-1 text-[11px] font-medium">
        <Icon className="size-3.5" />
        <span className="truncate">{label}</span>
      </span>
      <span className="text-sm font-semibold tabular-nums">{count}</span>
    </button>
  )
}

/* ------------------------------ Пустые состояния графика ------------------------------ */

export function ChartSkeleton() {
  return (
    <div className="flex min-h-[200px] flex-1 items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <span className="sr-only">Загрузка динамики источника</span>
    </div>
  )
}

export function ChartEmpty({ text }: { text: string }) {
  return (
    <p className="flex min-h-[200px] flex-1 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
      {text}
    </p>
  )
}
