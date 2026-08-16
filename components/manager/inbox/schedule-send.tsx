'use client'

/**
 * "Send later" popover for the composer (Telegram only). Telegram schedules
 * the message SERVER-SIDE (schedule_date), so delivery happens at the chosen
 * time even if the panel and worker are offline — classic "manager writes at
 * night, client reads in the morning" without waking anyone.
 */

import { useState } from 'react'
import { Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Label } from '@/components/ui/label'

/** Quick presets shown above the manual picker. Offsets in minutes. */
const PRESETS: { label: string; minutes: number }[] = [
  { label: 'Через 1 час', minutes: 60 },
  { label: 'Через 3 часа', minutes: 180 },
  { label: 'Завтра в 9:00', minutes: -1 }, // special-cased below
  { label: 'Завтра в 12:00', minutes: -2 },
]

/** Format a Date into the value expected by <input type="datetime-local">. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Client-side floor matching the server rule (>= 2 minutes out).
 * Module-scope on purpose: Date.now() is impure and must not run during render.
 */
function isTooSoon(date: Date): boolean {
  return date.getTime() < Date.now() + 2 * 60_000
}

/** Resolve a preset into a concrete Date (in the manager's local time). */
function presetToDate(minutes: number): Date {
  const d = new Date()
  if (minutes === -1 || minutes === -2) {
    d.setDate(d.getDate() + 1)
    d.setHours(minutes === -1 ? 9 : 12, 0, 0, 0)
    return d
  }
  d.setMinutes(d.getMinutes() + minutes, 0, 0)
  return d
}

export function ScheduleSendButton({
  disabled,
  hasText,
  onSchedule,
}: {
  disabled: boolean
  /** The button only acts when there is a drafted message to schedule. */
  hasText: boolean
  /** Called with the chosen moment as an ISO string; the parent sends. */
  onSchedule: (iso: string) => void
}) {
  const [open, setOpen] = useState(false)
  // Manual picker value; seeded to +1h whenever the popover opens.
  const [value, setValue] = useState('')

  function confirm(date: Date) {
    if (isTooSoon(date)) return
    setOpen(false)
    onSchedule(date.toISOString())
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && !hasText) return // nothing to schedule yet
        if (next) setValue(toLocalInputValue(presetToDate(60)))
        setOpen(next)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            disabled={disabled}
            aria-label="Отправить позже"
            title={
              hasText
                ? 'Отправить позже — Telegram доставит сообщение в выбранное время'
                : 'Сначала напишите сообщение, затем выберите время отправки'
            }
          >
            <Clock className="size-4" />
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-72 p-3">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">Отправить позже</p>
          <div className="grid grid-cols-2 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => confirm(presetToDate(p.minutes))}
                className="rounded-lg border border-border px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-at" className="text-xs">
              Или своё время
            </Label>
            <input
              id="schedule-at"
              type="datetime-local"
              value={value}
              min={toLocalInputValue(presetToDate(2))}
              onChange={(e) => setValue(e.target.value)}
              className="rounded-lg border border-border bg-muted px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
            />
            <Button
              type="button"
              size="sm"
              disabled={!value}
              onClick={() => {
                const d = new Date(value)
                if (!Number.isNaN(d.getTime())) confirm(d)
              }}
            >
              Запланировать
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Telegram доставит сообщение сам, даже если панель будет выключена.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
