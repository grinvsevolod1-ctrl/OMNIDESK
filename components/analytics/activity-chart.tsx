'use client'

/**
 * Interactive per-day stacked area chart (pan/zoom/hover). The intraday hour
 * line lives in activity-hour-chart.tsx and the pure path/axis math in
 * chart-math.ts; ActivityHour is re-exported for existing importers.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  PeopleByHourChart,
  type ActivityHour,
} from './activity-hour-chart'
import {
  areaBetween,
  axisTicks,
  clamp,
  dayTick,
  niceCeil,
  smoothPath,
} from './chart-math'

export type { ActivityHour } from './activity-hour-chart'

export type ActivityDay = {
  date: string
  telegram: number
  whatsapp: number
  livechat: number
  max: number
  vk: number
}

const DAY_COLORS = {
  telegram: '#0ea5e9',
  whatsapp: '#10b981',
  livechat: '#8b5cf6',
  max: '#f59e0b',
  vk: '#3b82f6',
} as const

/**
 * Interactive activity chart shared by the admin overview and the manager
 * dashboard. When `byHour` is provided (a single-day range) it renders the
 * intraday running line; otherwise it renders the pannable/zoomable per-day
 * stacked area. `title`/`hint` let each caller label the card.
 */
export function ActivityChart({
  byDay,
  byHour,
  title = 'Обращения по дням',
  hourTitle = 'Обращения за день',
}: {
  byDay: ActivityDay[]
  byHour: ActivityHour[] | null
  title?: string
  hourTitle?: string
}) {
  return byHour ? (
    <PeopleByHourChart byHour={byHour} title={hourTitle} />
  ) : (
    <PeopleByDayChart byDay={byDay} title={title} />
  )
}

function PeopleByDayChart({
  byDay,
  title,
}: {
  byDay: ActivityDay[]
  title: string
}) {
  const len = byDay.length
  const grandTotal = byDay.reduce(
    (n, d) => n + d.telegram + d.whatsapp + d.livechat + d.max + d.vk,
    0,
  )

  // Measure the container so the chart fills the width responsively (no scroll)
  // and text stays crisp (we render at real pixel size, not a stretched viewBox).
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Visible window over day indices — controls zoom (count) and pan (start).
  const [view, setView] = useState({ start: 0, count: len })
  useEffect(() => {
    // Reset zoom/pan window when the number of days changes (new dataset).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView({ start: 0, count: len })
  }, [len])

  const [hover, setHover] = useState<number | null>(null)
  const dragRef = useRef<{ x: number; start: number } | null>(null)

  const H = 264
  const padL = 32
  const padR = 16
  const padT = 16
  const padB = 28
  const plotW = Math.max(10, width - padL - padR)
  const plotH = H - padT - padB

  const start = clamp(view.start, 0, Math.max(0, len - 1))
  const count = clamp(view.count, Math.min(2, len), len)
  const visible = byDay.slice(start, start + count)
  const n = visible.length

  const vMax = Math.max(
    1,
    ...visible.map(
      (d) => d.telegram + d.whatsapp + d.livechat + d.max + d.vk,
    ),
  )
  const top = niceCeil(vMax)
  const ticks = axisTicks(top)

  const xAt = (i: number) =>
    padL + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1))
  const yAt = (v: number) => padT + plotH * (1 - v / top)

  // Stacked cumulative boundaries for smooth area layers.
  const zeros = visible.map((_, i) => [xAt(i), yAt(0)] as const)
  const tgTop = visible.map((d, i) => [xAt(i), yAt(d.telegram)] as const)
  const waTop = visible.map(
    (d, i) => [xAt(i), yAt(d.telegram + d.whatsapp)] as const,
  )
  const lcTop = visible.map(
    (d, i) => [xAt(i), yAt(d.telegram + d.whatsapp + d.livechat)] as const,
  )
  const maxTop = visible.map(
    (d, i) =>
      [xAt(i), yAt(d.telegram + d.whatsapp + d.livechat + d.max)] as const,
  )
  const sumTop = visible.map(
    (d, i) =>
      [
        xAt(i),
        yAt(d.telegram + d.whatsapp + d.livechat + d.max + d.vk),
      ] as const,
  )

  const labelStep = Math.max(1, Math.ceil(n / 8))

  // Wheel zoom, centered on the cursor. Native listener so we can preventDefault.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const f = clamp(
        (e.clientX - rect.left - padL) /
          Math.max(1, rect.width - padL - padR),
        0,
        1,
      )
      const dir = e.deltaY < 0 ? 0.82 : 1.22
      setView((prev) => {
        const cursor = prev.start + f * (prev.count - 1)
        const nextCount = clamp(Math.round(prev.count * dir), 2, len)
        const nextStart = clamp(
          Math.round(cursor - f * (nextCount - 1)),
          0,
          Math.max(0, len - nextCount),
        )
        return { start: nextStart, count: nextCount }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [len])

  // Plain function: it mutates a ref from a reactive value (`start`), which the
  // React Compiler can't preserve as a manual useCallback — so we let the
  // compiler memoize it automatically instead.
  const onPointerDown = (e: React.PointerEvent) => {
    // Capture on the element that owns the handler (the <svg>), never on a
    // child like <text>/<line> that may unmount on the next pan re-render.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { x: e.clientX, start }
  }

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const drag = dragRef.current
      if (drag) {
        // Read the drag anchor up front: the setView updater runs during the
        // next render, by which point a pointerup may have nulled dragRef and
        // dereferencing it inside the updater would throw and crash the page.
        const anchorStart = drag.start
        const anchorX = drag.x
        const pxPerDay = plotW / Math.max(1, count - 1)
        const deltaDays = (e.clientX - anchorX) / pxPerDay
        setView((prev) => ({
          ...prev,
          start: clamp(
            Math.round(anchorStart - deltaDays),
            0,
            Math.max(0, len - count),
          ),
        }))
      } else {
        const f = (e.clientX - rect.left - padL) / plotW
        const i = clamp(Math.round(f * (n - 1)), 0, n - 1)
        setHover(i)
      }
    },
    [plotW, count, len, n],
  )

  const endDrag = useCallback(() => {
    dragRef.current = null
  }, [])

  const hovered = hover != null && visible[hover] ? visible[hover] : null
  const hoveredSum = hovered
    ? hovered.telegram +
      hovered.whatsapp +
      hovered.livechat +
      hovered.max +
      hovered.vk
    : 0

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-medium">{title}</h2>
          <p className="text-xs text-muted-foreground">
            Всего {grandTotal} чел. · колесо — масштаб, перетаскивание — сдвиг
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <LegendDot className="bg-sky-500" label="Telegram" />
          <LegendDot className="bg-emerald-500" label="WhatsApp" />
          <LegendDot className="bg-violet-500" label="Чат" />
          <LegendDot className="bg-amber-500" label="MAX" />
          <LegendDot className="bg-blue-500" label="VK" />
        </div>
      </div>

      {grandTotal === 0 ? (
        <div className="mt-6 flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
          За выбранный период обращений не было.
        </div>
      ) : (
        <div ref={wrapRef} className="relative mt-5 w-full select-none">
          <svg
            width={width}
            height={H}
            className={cn('w-full touch-none cursor-grab active:cursor-grabbing')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={() => {
              endDrag()
              setHover(null)
            }}
            role="img"
            aria-label="График обращений по дням"
          >
            <defs>
              <linearGradient id="lc-day-tg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={DAY_COLORS.telegram} stopOpacity="0.7" />
                <stop offset="100%" stopColor={DAY_COLORS.telegram} stopOpacity="0.25" />
              </linearGradient>
            </defs>

            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={padL}
                  x2={width - padR}
                  y1={yAt(t)}
                  y2={yAt(t)}
                  stroke="var(--border)"
                  strokeWidth="1"
                  opacity="0.6"
                />
                <text
                  x={padL - 6}
                  y={yAt(t) + 3}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  fontSize="10"
                >
                  {t}
                </text>
              </g>
            ))}

            {/* Stacked smooth areas (bottom → top) */}
            <path d={areaBetween(zeros, tgTop)} fill="url(#lc-day-tg)" />
            <path
              d={areaBetween(tgTop, waTop)}
              fill={DAY_COLORS.whatsapp}
              fillOpacity="0.55"
            />
            <path
              d={areaBetween(waTop, lcTop)}
              fill={DAY_COLORS.livechat}
              fillOpacity="0.55"
            />
            <path
              d={areaBetween(lcTop, maxTop)}
              fill={DAY_COLORS.max}
              fillOpacity="0.55"
            />
            <path
              d={areaBetween(maxTop, sumTop)}
              fill={DAY_COLORS.vk}
              fillOpacity="0.55"
            />
            <path
              d={smoothPath(sumTop)}
              fill="none"
              stroke={DAY_COLORS.telegram}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {visible.map((d, i) =>
              i % labelStep === 0 || i === n - 1 ? (
                <text
                  key={d.date}
                  x={xAt(i)}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  fontSize="10"
                >
                  {dayTick(d.date)}
                </text>
              ) : null,
            )}

            {hovered ? (
              <g pointerEvents="none">
                <line
                  x1={xAt(hover!)}
                  x2={xAt(hover!)}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="var(--border)"
                  strokeWidth="1"
                />
                <circle
                  cx={xAt(hover!)}
                  cy={yAt(hoveredSum)}
                  r="4"
                  fill={DAY_COLORS.telegram}
                  stroke="var(--background)"
                  strokeWidth="2"
                />
              </g>
            ) : null}
          </svg>

          {hovered ? (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md"
              style={{
                left: clamp(xAt(hover!), 80, width - 80),
                top: 4,
              }}
            >
              <div className="font-medium text-popover-foreground">
                {dayTick(hovered.date)} · {hoveredSum} чел.
              </div>
              <div className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-sky-500" /> TG{' '}
                  {hovered.telegram}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-emerald-500" /> WA{' '}
                  {hovered.whatsapp}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-violet-500" /> Чат{' '}
                  {hovered.livechat}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-amber-500" /> MAX{' '}
                  {hovered.max}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-blue-500" /> VK{' '}
                  {hovered.vk}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  )
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-2 rounded-full', className)} />
      {label}
    </span>
  )
}

/* Path/axis math moved to chart-math.ts */
