'use client'

import { useEffect, useState, useTransition } from 'react'
import dynamic from 'next/dynamic'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getManagerActivityAnalyticsAction } from '@/app/actions/manager-analytics'
// Large canvas chart whose data is fetched client-side after mount; keep it out
// of the manager home's initial bundle and load it lazily. ssr:false since
// there's nothing meaningful to render before the client fetch resolves.
const ActivityChart = dynamic(
  () =>
    import('@/components/analytics/activity-chart').then((m) => m.ActivityChart),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse rounded-lg bg-muted/40" />,
  },
)
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { ManagerActivityAnalytics } from '@/lib/data'

type Preset = 'today' | '7d' | '30d' | 'custom'

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function rangeFromPreset(preset: Exclude<Preset, 'custom'>): {
  from: Date
  to: Date
} {
  const todayStart = startOfDay(new Date())
  const tomorrow = new Date(todayStart)
  tomorrow.setDate(todayStart.getDate() + 1)
  if (preset === 'today') return { from: todayStart, to: tomorrow }
  const from = new Date(todayStart)
  from.setDate(todayStart.getDate() - (preset === '7d' ? 6 : 29))
  return { from, to: tomorrow }
}

export function ManagerActivityChart() {
  const [preset, setPreset] = useState<Preset>('today')
  const [customFrom, setCustomFrom] = useState(() =>
    ymd(rangeFromPreset('7d').from),
  )
  const [customTo, setCustomTo] = useState(() => ymd(startOfDay(new Date())))
  const [analytics, setAnalytics] = useState<ManagerActivityAnalytics | null>(
    null,
  )
  const [pending, startTransition] = useTransition()

  function currentRange(p: Preset): { from: string; to: string } {
    if (p === 'custom') {
      const from = startOfDay(new Date(customFrom + 'T00:00:00'))
      const toBase = startOfDay(new Date(customTo + 'T00:00:00'))
      const to = new Date(toBase)
      to.setDate(toBase.getDate() + 1) // inclusive end day → exclusive bound
      return { from: from.toISOString(), to: to.toISOString() }
    }
    const r = rangeFromPreset(p)
    return { from: r.from.toISOString(), to: r.to.toISOString() }
  }

  function load(p: Preset) {
    const { from, to } = currentRange(p)
    // The browser knows the manager's timezone; the server buckets days with it
    // so "today" matches the local clock instead of the server's UTC date.
    const tz = new Date().getTimezoneOffset()
    startTransition(async () => {
      const res = await getManagerActivityAnalyticsAction(from, to, tz)
      if (res.ok && res.data) setAnalytics(res.data)
      else toast.error(res.message ?? 'Не удалось загрузить отчёт.')
    })
  }

  // Load the default report ("today") once on mount with the client's real
  // timezone. We don't render on the server because it would compute "today"
  // in UTC and could be off by a day for the manager.
  useEffect(() => {
    load('today')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onPresetChange(p: Preset) {
    setPreset(p)
    if (p !== 'custom') load(p)
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground">
        Активность обращений
      </h2>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Период</Label>
          <div className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1">
            {(
              [
                ['today', 'Сегодня'],
                ['7d', '7 дней'],
                ['30d', '30 дней'],
                ['custom', 'Период'],
              ] as [Preset, string][]
            ).map(([p, label]) => (
              <button
                key={p}
                type="button"
                onClick={() => onPresetChange(p)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  preset === p
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {preset === 'custom' ? (
          <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">С</Label>
              <Input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="w-[160px]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">По</Label>
              <Input
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(e) => setCustomTo(e.target.value)}
                className="w-[160px]"
              />
            </div>
            <button
              type="button"
              onClick={() => load('custom')}
              disabled={pending}
              className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              Показать
            </button>
          </div>
        ) : null}
      </Card>

      {pending && !analytics ? (
        <Card className="flex h-64 items-center justify-center p-5">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </Card>
      ) : analytics ? (
        <div className={cn(pending && 'opacity-60 transition-opacity')}>
          <ActivityChart
            byDay={analytics.byDay}
            byHour={analytics.byHour}
            title="Ваши обращения по дням"
            hourTitle="Ваши обращения за день"
          />
        </div>
      ) : null}
    </section>
  )
}
