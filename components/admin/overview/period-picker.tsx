'use client'

import { useState } from 'react'
import { CalendarRange } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { startOfDay, ymd } from '@/components/admin/dashboard/source-groups/shared'
import { cn } from '@/lib/utils'
import type { PeriodPreset } from './use-overview-prefs'

export interface ResolvedPeriod {
  from: Date
  /** Эксклюзивная граница (начало следующего дня). */
  to: Date
  /** Человекочитаемая подпись: «7 дней · 10 фев — 16 фев». */
  label: string
}

const PRESETS: { id: Exclude<PeriodPreset, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Сегодня' },
  { id: 'yesterday', label: 'Вчера' },
  { id: '7d', label: '7 дней' },
  { id: '30d', label: '30 дней' },
  { id: '90d', label: '90 дней' },
]

const FMT = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' })

function fmtRange(from: Date, toExclusive: Date): string {
  const last = new Date(toExclusive)
  last.setDate(last.getDate() - 1)
  const a = FMT.format(from)
  const b = FMT.format(last)
  return a === b ? a : `${a} — ${b}`
}

/**
 * Разворачивает пресет/произвольные даты в границы [from, to).
 * Обе даты custom-диапазона включительны: «по 15 фев» захватывает весь день.
 * Невалидный custom тихо падает на 7 дней — фильтр никогда не «ломается».
 */
export function resolvePeriod(
  preset: PeriodPreset,
  customFrom: string,
  customTo: string,
): ResolvedPeriod {
  const todayStart = startOfDay(new Date())
  const tomorrow = new Date(todayStart)
  tomorrow.setDate(todayStart.getDate() + 1)

  if (preset === 'today')
    return { from: todayStart, to: tomorrow, label: `Сегодня · ${FMT.format(todayStart)}` }

  if (preset === 'yesterday') {
    const from = new Date(todayStart)
    from.setDate(todayStart.getDate() - 1)
    return { from, to: todayStart, label: `Вчера · ${FMT.format(from)}` }
  }

  if (preset === 'custom') {
    const f = customFrom ? startOfDay(new Date(`${customFrom}T00:00:00`)) : null
    const t = customTo ? startOfDay(new Date(`${customTo}T00:00:00`)) : null
    if (f && t && !Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime())) {
      // Даты в любом порядке: нормализуем, границу делаем включительной.
      const from = f <= t ? f : t
      const lastDay = f <= t ? t : f
      const to = new Date(lastDay)
      to.setDate(to.getDate() + 1)
      return { from, to, label: fmtRange(from, to) }
    }
    // Фолбэк — 7 дней
  }

  const days = preset === '30d' ? 30 : preset === '90d' ? 90 : 7
  const from = new Date(todayStart)
  from.setDate(todayStart.getDate() - (days - 1))
  const label = `${PRESETS.find((p) => p.id === preset)?.label ?? '7 дней'} · ${fmtRange(from, tomorrow)}`
  return { from, to: tomorrow, label }
}

/**
 * Переключатель периода Обзора: быстрые пресеты + произвольный диапазон дат.
 * Текущий период всегда подписан явными датами — видно, что именно выбрано.
 */
export function PeriodPicker({
  preset,
  customFrom,
  customTo,
  resolved,
  onChange,
}: {
  preset: PeriodPreset
  customFrom: string
  customTo: string
  resolved: ResolvedPeriod
  onChange: (patch: {
    preset: PeriodPreset
    customFrom?: string
    customTo?: string
  }) => void
}) {
  const [open, setOpen] = useState(false)
  // Черновик дат внутри поповера — применяется кнопкой, а не на каждый ввод.
  const [draftFrom, setDraftFrom] = useState(customFrom)
  const [draftTo, setDraftTo] = useState(customTo)

  const todayYmd = ymd(new Date())

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <div
        role="group"
        aria-label="Период"
        className="flex items-center rounded-lg border border-border p-0.5"
      >
        {PRESETS.map((p) => (
          <Button
            key={p.id}
            variant="ghost"
            size="sm"
            onClick={() => onChange({ preset: p.id })}
            className={cn(
              'h-7 rounded-md px-2.5 text-xs',
              preset === p.id
                ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground'
                : 'text-muted-foreground',
            )}
            aria-pressed={preset === p.id}
          >
            {p.label}
          </Button>
        ))}

        <Popover
          open={open}
          onOpenChange={(v) => {
            setOpen(v)
            if (v) {
              setDraftFrom(customFrom)
              setDraftTo(customTo)
            }
          }}
        >
          <PopoverTrigger
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
              preset === 'custom'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            aria-pressed={preset === 'custom'}
          >
            <CalendarRange className="size-3.5" />
            Даты
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-3">
            <form
              className="flex flex-col gap-2.5"
              onSubmit={(e) => {
                e.preventDefault()
                if (!draftFrom || !draftTo) return
                onChange({
                  preset: 'custom',
                  customFrom: draftFrom,
                  customTo: draftTo,
                })
                setOpen(false)
              }}
            >
              <div className="flex items-center gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  С
                  <Input
                    type="date"
                    value={draftFrom}
                    max={todayYmd}
                    onChange={(e) => setDraftFrom(e.target.value)}
                    className="h-8 w-36"
                    required
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  По (включительно)
                  <Input
                    type="date"
                    value={draftTo}
                    max={todayYmd}
                    onChange={(e) => setDraftTo(e.target.value)}
                    className="h-8 w-36"
                    required
                  />
                </label>
              </div>
              <Button
                type="submit"
                size="sm"
                className="h-8"
                disabled={!draftFrom || !draftTo}
              >
                Показать период
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      </div>

      {/* Явная подпись выбранного периода — никакой двусмысленности */}
      <p className="text-xs text-muted-foreground tabular-nums">
        {resolved.label}
      </p>
    </div>
  )
}
