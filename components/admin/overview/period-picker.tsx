'use client'

import { PeriodFilter } from '@/components/shared/period-filter'
import {
  startOfDay,
  ymd,
} from '@/components/admin/dashboard/source-groups/shared'
import type { PeriodPreset } from './use-overview-prefs'

export interface ResolvedPeriod {
  from: Date
  /** Эксклюзивная граница (начало следующего дня). */
  to: Date
  /** Человекочитаемая подпись: «7 дней · 10 фев — 16 фев». */
  label: string
}

const PRESETS: { key: Exclude<PeriodPreset, 'range'>; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: '90d', label: '90 дней' },
]

/** Полный список пресетов Обзора для инлайнового переключателя. */
const OVERVIEW_PRESETS: { key: PeriodPreset; label: string }[] = [
  ...PRESETS,
  { key: 'range', label: 'Период' },
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
 * Обе даты произвольного диапазона включительны: «по 15 фев» захватывает весь
 * день. Невалидный диапазон тихо падает на 7 дней — фильтр никогда не «ломается».
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
    return {
      from: todayStart,
      to: tomorrow,
      label: `Сегодня · ${FMT.format(todayStart)}`,
    }

  if (preset === 'yesterday') {
    const from = new Date(todayStart)
    from.setDate(todayStart.getDate() - 1)
    return { from, to: todayStart, label: `Вчера · ${FMT.format(from)}` }
  }

  if (preset === 'range') {
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
  const label = `${OVERVIEW_PRESETS.find((p) => p.key === preset)?.label ?? '7 дней'} · ${fmtRange(from, tomorrow)}`
  return { from, to: tomorrow, label }
}

/**
 * Переключатель периода Обзора — тонкий адаптер над общим PeriodFilter.
 * Быстрые пресеты + инлайновый диапазон дат (тот же вид, что в списках лидов).
 * Выбранный период всегда подписан явными датами справа — видно, что выбрано.
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
  const todayYmd = ymd(new Date())

  // При переключении на «Период» заполняем оба инпута текущим окном, чтобы
  // диапазон не начинался с пустых полей (и сразу был осмысленным).
  const handlePreset = (key: PeriodPreset) => {
    if (key === 'range') {
      const lastDay = new Date(resolved.to)
      lastDay.setDate(lastDay.getDate() - 1)
      onChange({
        preset: 'range',
        customFrom: customFrom || ymd(resolved.from),
        customTo: customTo || ymd(lastDay),
      })
    } else {
      onChange({ preset: key })
    }
  }

  return (
    <PeriodFilter
      presets={OVERVIEW_PRESETS}
      preset={preset}
      from={customFrom}
      to={customTo}
      today={todayYmd}
      onPreset={handlePreset}
      onFrom={(v) => onChange({ preset: 'range', customFrom: v, customTo })}
      onTo={(v) => onChange({ preset: 'range', customFrom, customTo: v })}
      trailing={
        <p className="text-xs tabular-nums text-muted-foreground">
          {resolved.label}
        </p>
      }
    />
  )
}
