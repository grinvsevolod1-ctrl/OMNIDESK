'use client'

import type { LucideIcon } from 'lucide-react'
import { TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/**
 * Крупная масштабируемая «карта-вкладка» источника вместо сжатых чипов.
 * Иконка + название + живая метрика (лиды / кабинеты / расход / секреты).
 * Построена поверх shadcn TabsTrigger, поэтому переключение и доступность
 * работают штатно, а сетка в TabsList тянется на всю ширину.
 */
export function SourceTabCard({
  value,
  active,
  icon: Icon,
  label,
  stat,
}: {
  value: string
  active: boolean
  icon: LucideIcon
  label: string
  stat: string
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'flex h-auto flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors sm:p-4',
        'data-active:border-primary data-active:bg-primary/5 data-active:shadow-none',
        active
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card hover:bg-muted/50',
      )}
    >
      <span
        className={cn(
          'flex size-9 items-center justify-center rounded-lg',
          active
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4.5" />
      </span>
      <span className="flex flex-col">
        <span
          className={cn(
            'text-sm font-semibold',
            active ? 'text-foreground' : 'text-foreground/90',
          )}
        >
          {label}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {stat}
        </span>
      </span>
    </TabsTrigger>
  )
}
