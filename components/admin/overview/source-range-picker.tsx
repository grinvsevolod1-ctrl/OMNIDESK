'use client'

/**
 * Поповер выбора произвольного диапазона дат для фильтра периода отчёта
 * источника. Черновик синхронизируется с текущим диапазоном при открытии.
 * Вынесено из source-detail-dialog.
 */

import { useState } from 'react'
import { CalendarRange } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export function CustomRangePicker({
  active,
  from,
  to,
  max,
  label,
  onApply,
}: {
  active: boolean
  from: string
  to: string
  max: string
  label: string
  onApply: (from: string, to: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draftFrom, setDraftFrom] = useState(from)
  const [draftTo, setDraftTo] = useState(to)

  // При каждом открытии синхронизируем черновик с текущим диапазоном.
  function handleOpenChange(next: boolean) {
    if (next) {
      setDraftFrom(from)
      setDraftTo(to)
    }
    setOpen(next)
  }

  const invalid = draftFrom > draftTo

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          />
        }
      >
        <CalendarRange className="size-3.5" />
        {label}
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-64 space-y-3">
        <p className="text-sm font-medium">Произвольный период</p>
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">С</span>
            <input
              type="date"
              value={draftFrom}
              max={draftTo || max}
              onChange={(e) => setDraftFrom(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">По</span>
            <input
              type="date"
              value={draftTo}
              min={draftFrom}
              max={max}
              onChange={(e) => setDraftTo(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        </div>
        {invalid ? (
          <p className="text-xs text-destructive">
            Дата «С» не может быть позже даты «По».
          </p>
        ) : null}
        <Button
          size="sm"
          className="w-full"
          disabled={invalid || !draftFrom || !draftTo}
          onClick={() => {
            onApply(draftFrom, draftTo)
            setOpen(false)
          }}
        >
          Применить
        </Button>
      </PopoverContent>
    </Popover>
  )
}
