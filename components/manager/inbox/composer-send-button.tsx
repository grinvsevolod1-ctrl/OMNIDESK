'use client'

/**
 * Unified send/schedule button, Telegram-style: a normal tap submits the
 * draft; press-and-hold (mouse or touch, via Pointer Events) opens a "send
 * later" panel — replacing the old always-visible standalone Clock button
 * that used to compete for space with mic/emoji/sticker/attach on a phone
 * screen. Schedule delivery is Telegram-only server-side (schedule_date), so
 * `canSchedule` gates the whole long-press affordance off for other channels.
 *
 * The panel is a hand-rolled absolutely-positioned popup (not the shared
 * Popover primitive): Base UI's Popover.Trigger wires a floating-ui `click`
 * interaction that toggles open on every tap, which would fight the
 * long-press gesture on a short tap. A plain anchored div plus a backdrop to
 * dismiss is simpler and fully under our control here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { SendHorizonal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

const LONG_PRESS_MS = 450

const PRESETS: { label: string; minutes: number }[] = [
  { label: 'Через 1 час', minutes: 60 },
  { label: 'Через 3 часа', minutes: 180 },
  { label: 'Завтра в 9:00', minutes: -1 }, // special-cased below
  { label: 'Завтра в 12:00', minutes: -2 },
]

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Client-side floor matching the server rule (>= 2 minutes out). */
function isTooSoon(date: Date): boolean {
  return date.getTime() < Date.now() + 2 * 60_000
}

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

export function ComposerSendButton({
  disabled,
  canSchedule,
  onSubmit,
  onSchedule,
}: {
  disabled: boolean
  /** Whether holding the button should offer "send later" at all. */
  canSchedule: boolean
  onSubmit: () => void
  onSchedule: (iso: string) => void
}) {
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [value, setValue] = useState('')
  const longPressFiredRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  // Close on Escape, matching the shared Popover's keyboard behaviour.
  useEffect(() => {
    if (!scheduleOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setScheduleOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [scheduleOpen])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || !canSchedule || e.button !== 0) return
      longPressFiredRef.current = false
      clearTimer()
      timerRef.current = setTimeout(() => {
        longPressFiredRef.current = true
        setValue(toLocalInputValue(presetToDate(60)))
        setScheduleOpen(true)
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(10)
        }
      }, LONG_PRESS_MS)
    },
    [disabled, canSchedule, clearTimer],
  )

  const handlePointerEnd = useCallback(() => {
    clearTimer()
  }, [clearTimer])

  const handleClick = useCallback(() => {
    clearTimer()
    if (longPressFiredRef.current) {
      // The tap that ends a long press must not ALSO submit — the popover it
      // opened is the intended result of this gesture.
      longPressFiredRef.current = false
      return
    }
    onSubmit()
  }, [onSubmit, clearTimer])

  function confirm(date: Date) {
    if (isTooSoon(date)) return
    setScheduleOpen(false)
    onSchedule(date.toISOString())
  }

  return (
    <div className="relative">
      <Button
        type="button"
        size="icon"
        className="size-10 shrink-0 touch-none rounded-full select-none"
        disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerEnd}
        onPointerLeave={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onContextMenu={(e) => e.preventDefault()}
        onClick={handleClick}
        aria-label="Отправить"
        title={
          canSchedule
            ? 'Отправить (удержите — запланировать)'
            : 'Отправить'
        }
      >
        <SendHorizonal className="size-4" />
      </Button>

      {scheduleOpen ? (
        <>
          {/* Backdrop: tap outside to dismiss without scheduling. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setScheduleOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Отправить позже"
            className="absolute bottom-full right-0 z-50 mb-2 w-72 origin-bottom-right animate-in fade-in-0 zoom-in-95 rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100"
          >
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
                Telegram доставит сообщение сам, даже если панель будет
                выключена.
              </p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
