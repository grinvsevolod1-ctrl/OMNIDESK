'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type ActivityDay = {
  date: string
  telegram: number
  whatsapp: number
  livechat: number
  max: number
  vk: number
}

export type ActivityHour = {
  hour: number
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

function PeopleByHourChart({
  byHour,
  title,
}: {
  byHour: ActivityHour[]
  title: string
}) {
  const totals = byHour.map(
    (h) => h.telegram + h.whatsapp + h.livechat + h.max + h.vk,
  )
  const sum = totals.reduce((n, v) => n + v, 0)
  const max = Math.max(1, ...totals)
  const top = niceCeil(max)
  const ticks = axisTicks(top)
  const peakHour = totals.indexOf(Math.max(...totals))

  const W = 960
  const H = 240
  const padL = 28
  const padR = 12
  const padT = 16
  const padB = 24
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const x = (i: number) => padL + (plotW * i) / 23
  const y = (v: number) => padT + plotH * (1 - v / top)

  const pts = totals.map((v, i) => [x(i), y(v)] as const)
  const linePath = smoothPath(pts)
  const areaPath = `${linePath} L ${x(23)} ${padT + plotH} L ${x(0)} ${padT + plotH} Z`

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-medium">{title}</h2>
          <p className="text-xs text-muted-foreground">
            Почасовая динамика · всего {sum} чел.
          </p>
        </div>
        {sum > 0 ? (
          <span className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            Пик: {String(peakHour).padStart(2, '0')}:00 · {totals[peakHour]}
          </span>
        ) : null}
      </div>

      {sum === 0 ? (
        <div className="mt-6 flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
          Сегодня обращений ещё не было.
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="mt-5 h-60 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label="Почасовой график обращений за день"
        >
          <defs>
            <linearGradient id="lc-hour-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
            </linearGradient>
          </defs>

          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--border)"
                strokeWidth="1"
                opacity="0.6"
              />
              <text
                x={padL - 6}
                y={y(t) + 3}
                textAnchor="end"
                className="fill-muted-foreground"
                fontSize="10"
              >
                {t}
              </text>
            </g>
          ))}

          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <text
              key={h}
              x={x(h)}
              y={H - 6}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize="10"
            >
              {String(h).padStart(2, '0')}
            </text>
          ))}

          <path d={areaPath} fill="url(#lc-hour-fill)" />
          <path
            d={linePath}
            fill="none"
            stroke="#0ea5e9"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle
            cx={x(peakHour)}
            cy={y(totals[peakHour])}
            r="4"
            fill="#0ea5e9"
            stroke="var(--background)"
            strokeWidth="2"
          />
        </svg>
      )}
    </Card>
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
          За выбранный перио�� обращений не было.
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

function dayTick(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00')
  return `${d.toLocaleDateString('ru-RU', { weekday: 'short' })} ${d.getDate()}`
}

/** Build a smooth cubic-Bézier path through points using Catmull-Rom. */
function smoothPath(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`
  }
  return d
}

/** Smooth filled band between a lower and an upper boundary (both point arrays). */
function areaBetween(
  lower: readonly (readonly [number, number])[],
  upper: readonly (readonly [number, number])[],
): string {
  if (!upper.length) return ''
  const topCurve = smoothPath(upper)
  const bottomCurve = smoothPath([...lower].reverse()).replace(/^M/, 'L')
  return `${topCurve} ${bottomCurve} Z`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Round a max value up to a clean axis ceiling (1, 2, 5, 10, 20, 50…). */
function niceCeil(n: number): number {
  if (n <= 1) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(n)))
  const frac = n / pow
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10
  return nice * pow
}

/** Up to 5 evenly spaced whole-number ticks from 0 to top (descending). */
function axisTicks(top: number): number[] {
  const steps = Math.min(top, 4)
  const out: number[] = []
  for (let i = steps; i >= 0; i--) out.push(Math.round((top / steps) * i))
  return [...new Set(out)]
}
