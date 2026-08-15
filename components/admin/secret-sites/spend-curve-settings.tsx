'use client'

import { useId, useMemo } from 'react'
import type { AutoSpend } from '@/lib/god-sites'
import {
  DEFAULT_DAY_JITTER,
  DEFAULT_WEEKEND_DIP,
  dayCurveAt,
  type SpendProfile,
} from '@/lib/god-sites-sim'
import { Label } from '@/components/ui/label'

/**
 * Spend-curve settings for auto-spend: day-shape profile, S-curve smoothing,
 * weekend dip, day-to-day jitter — plus a live 24h SVG preview drawn from the
 * SAME pure math the server uses (lib/god-sites-sim.ts), so what the operator
 * sees here is exactly what the vitrine will burn.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only.
 */

const PROFILE_OPTIONS: {
  value: SpendProfile
  label: string
  desc: string
}[] = [
  {
    value: 'standard',
    label: 'Стандартный',
    desc: 'Ночь тихая, день ровный, пик вечером',
  },
  {
    value: 'morning',
    label: 'Утренний',
    desc: 'Разгон с 6–7, пик 9–13, спад после 18',
  },
  {
    value: 'evening',
    label: 'Вечерний',
    desc: 'Тихий день, разгон с 16, пик 19–23',
  },
  {
    value: 'always',
    label: 'Круглосуточный',
    desc: 'Почти ровно 24/7 — без ночного провала',
  },
]

export function SpendCurveSettings({
  auto,
  currency,
  onChange,
}: {
  auto: AutoSpend
  currency: string
  onChange: (patch: Partial<AutoSpend>) => void
}) {
  const profile = auto.profile ?? 'standard'
  const smoothness = auto.smoothness ?? 0.6
  const weekendDip = auto.weekendDip ?? DEFAULT_WEEKEND_DIP
  const dayJitter = auto.dayJitter ?? DEFAULT_DAY_JITTER
  const usingLegacy = auto.profile === undefined

  return (
    <div className="flex flex-col gap-4">
      {/* Profile preset selector */}
      <div className="flex flex-col gap-1.5">
        <Label>Профиль дня</Label>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {PROFILE_OPTIONS.map((p) => {
            const active = !usingLegacy && profile === p.value
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => onChange({ profile: p.value })}
                aria-pressed={active}
                className={`flex flex-col gap-0.5 rounded-lg border p-2.5 text-left transition-colors ${
                  active
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card hover:bg-muted/60'
                }`}
              >
                <span
                  className={`text-sm font-medium ${active ? 'text-primary' : ''}`}
                >
                  {p.label}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">
                  {p.desc}
                </span>
              </button>
            )
          })}
        </div>
        {usingLegacy && (
          <p className="text-xs text-muted-foreground">
            Сейчас используется историческая кривая (без профиля). Выберите
            профиль, чтобы включить плавную S-кривую и настройки ниже.
          </p>
        )}
      </div>

      {/* Live 24h curve preview */}
      <CurvePreview
        profile={profile}
        smoothness={usingLegacy ? 0 : smoothness}
        dailyBudget={auto.dailyBudget}
        currency={currency}
        tzOffsetHours={auto.tzOffsetHours ?? 3}
      />

      {/* Fine-tuning sliders — only meaningful once a profile is chosen */}
      {!usingLegacy && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SliderField
            label="Сглаживание"
            hint={
              smoothness < 0.25
                ? 'почти ступенчатая'
                : smoothness > 0.75
                  ? 'полностью плавная'
                  : 'умеренная'
            }
            value={smoothness}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => onChange({ smoothness: v })}
          />
          <SliderField
            label="Проседание выходных"
            hint={
              weekendDip === 0
                ? 'неделя ровная'
                : `вс −${Math.round(weekendDip * 100)}%, сб −${Math.round(weekendDip * 75)}%`
            }
            value={weekendDip}
            max={0.5}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => onChange({ weekendDip: v })}
          />
          <SliderField
            label="Разброс между днями"
            hint={dayJitter === 0 ? 'дни одинаковые' : 'дни слегка разные'}
            value={dayJitter}
            max={0.2}
            step={0.01}
            format={(v) => `±${Math.round(v * 100)}%`}
            onChange={(v) => onChange({ dayJitter: v })}
          />
        </div>
      )}
    </div>
  )
}

/* ------------------------------- Preview -------------------------------- */

/**
 * 24-hour burn-rate curve + cumulative overlay, pure SVG. X = hour of day,
 * left Y = burn rate, thin line = cumulative share. A vertical marker shows
 * "now" in the site's timezone.
 */
function CurvePreview({
  profile,
  smoothness,
  dailyBudget,
  currency,
  tzOffsetHours,
}: {
  profile: SpendProfile
  smoothness: number
  dailyBudget: number
  currency: string
  tzOffsetHours: number
}) {
  const gradId = useId()
  const W = 720
  const H = 120
  const PAD = 8

  const { ratePath, cumPath, nowX, nowCum } = useMemo(() => {
    // Sample the cumulative curve, derive the rate as its slope — guarantees
    // the two lines always agree (both come from dayCurveAt).
    const STEPS = 96 // 15-minute grid
    const cum: number[] = []
    for (let i = 0; i <= STEPS; i++) {
      cum.push(dayCurveAt((i / STEPS) * 24, profile, smoothness))
    }
    const rates: number[] = []
    for (let i = 0; i < STEPS; i++) rates.push(cum[i + 1] - cum[i])
    const maxRate = Math.max(...rates, 1e-9)

    const x = (i: number) => PAD + (i / STEPS) * (W - PAD * 2)
    const yRate = (r: number) => H - PAD - (r / maxRate) * (H - PAD * 2)
    const yCum = (c: number) => H - PAD - c * (H - PAD * 2)

    const rp = rates
      .map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i + 0.5).toFixed(1)},${yRate(r).toFixed(1)}`)
      .join(' ')
    const cp = cum
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${yCum(c).toFixed(1)}`)
      .join(' ')

    const shifted = new Date(Date.now() + tzOffsetHours * 3_600_000)
    const hourFloat = shifted.getUTCHours() + shifted.getUTCMinutes() / 60
    return {
      ratePath: rp,
      cumPath: cp,
      nowX: PAD + (hourFloat / 24) * (W - PAD * 2),
      nowCum: dayCurveAt(hourFloat, profile, smoothness),
    }
  }, [profile, smoothness, tzOffsetHours])

  return (
    <figure className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-28 w-full rounded-lg border bg-muted/30"
        role="img"
        aria-label="Кривая скорости расхода за 24 часа"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Hour gridlines every 6h */}
        {[6, 12, 18].map((h) => {
          const gx = PAD + (h / 24) * (W - PAD * 2)
          return (
            <line
              key={h}
              x1={gx}
              y1={PAD}
              x2={gx}
              y2={H - PAD}
              className="stroke-border"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
          )
        })}
        {/* Burn-rate area + line */}
        <path
          d={`${ratePath} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`}
          fill={`url(#${gradId})`}
          className="text-primary"
        />
        <path
          d={ratePath}
          fill="none"
          className="stroke-primary"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* Cumulative overlay */}
        <path
          d={cumPath}
          fill="none"
          className="stroke-muted-foreground/50"
          strokeWidth="1.5"
          strokeDasharray="4 3"
        />
        {/* "Now" marker */}
        <line
          x1={nowX}
          y1={PAD}
          x2={nowX}
          y2={H - PAD}
          className="stroke-success"
          strokeWidth="1.5"
        />
      </svg>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          00 — 06 — 12 — 18 — 24 ч ·{' '}
          <span className="text-primary">скорость расхода</span> ·{' '}
          <span>пунктир — накоплено</span>
        </span>
        <span>
          сейчас накоплено{' '}
          <span className="font-mono font-medium text-foreground">
            {Math.round(nowCum * 100)}% ≈{' '}
            {new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(
              nowCum * dailyBudget,
            )}{' '}
            {currency}
          </span>
        </span>
      </figcaption>
    </figure>
  )
}

/* ----------------------------- Slider field ----------------------------- */

function SliderField({
  label,
  hint,
  value,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  hint: string
  value: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span className="font-mono text-xs text-muted-foreground">
          {format(value)}
        </span>
      </div>
      {/* Native range input — the project has no Slider primitive and one
          dependency-free input beats adding a package for three sliders. */}
      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
