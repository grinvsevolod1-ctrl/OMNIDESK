'use client'

/**
 * Intraday (single-day) activity line: hourly totals across all channels with
 * a peak marker. Extracted from activity-chart.tsx; used when the caller has
 * a `byHour` dataset.
 */

import { Card } from '@/components/ui/card'
import { axisTicks, niceCeil, smoothPath } from './chart-math'

export type ActivityHour = {
  hour: number
  telegram: number
  whatsapp: number
  livechat: number
  max: number
  vk: number
}

export function PeopleByHourChart({
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
