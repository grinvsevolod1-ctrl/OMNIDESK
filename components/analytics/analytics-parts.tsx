import { Send, Phone } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  LEAD_STATUS_META,
  LEAD_STATUS_ORDER,
  type LeadStatus,
} from '@/lib/types'

/**
 * Shared, presentational analytics widgets used by both the manager overview
 * (/app) and the admin analytics dashboard (/admin/analytics). They render data
 * that is computed server-side in lib/data.ts so the metrics stay consistent
 * across both views.
 */

const STATUS_BAR: Record<LeadStatus, string> = {
  unsubscribed: 'bg-sky-500',
  handoff: 'bg-amber-500',
  liquid: 'bg-teal-500',
  not_liquid: 'bg-muted-foreground',
  transferred: 'bg-emerald-500',
}

/** Short weekday + day label for the trend charts, e.g. "пн 5". */
function dayTick(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00')
  const wd = d.toLocaleDateString('ru-RU', { weekday: 'short' })
  return `${wd} ${d.getDate()}`
}

/** Lead distribution by status: count, share, and a proportional bar. */
export function LeadStatusBreakdown({
  byStatus,
  total,
}: {
  byStatus: Record<LeadStatus, number>
  total: number
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Лиды по статусам</h2>
        <span className="text-xs text-muted-foreground">всего {total}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Распределение контактов, которые написали, по этапам воронки.
      </p>

      {total === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Пока нет лидов для анализа.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {LEAD_STATUS_ORDER.map((s) => {
            const count = byStatus[s] ?? 0
            const pct = total > 0 ? Math.round((count / total) * 100) : 0
            return (
              <li key={s} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span
                      className={cn('size-2 rounded-full', STATUS_BAR[s])}
                      aria-hidden
                    />
                    <span className="font-medium">
                      {LEAD_STATUS_META[s].label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {LEAD_STATUS_META[s].description}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {count} · {pct}%
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn('h-full rounded-full', STATUS_BAR[s])}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/** 7-day trend of new leads (single series of vertical bars). */
export function LeadTrendChart({
  byDay,
}: {
  byDay: { date: string; count: number }[]
}) {
  const max = Math.max(1, ...byDay.map((d) => d.count))
  const total = byDay.reduce((n, d) => n + d.count, 0)
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Новые лиды за 7 дней</h2>
        <span className="text-xs text-muted-foreground">всего {total}</span>
      </div>
      <div className="mt-5 flex items-end justify-between gap-2">
        {byDay.map((d) => {
          const h = Math.round((d.count / max) * 100)
          return (
            <div
              key={d.date}
              className="flex flex-1 flex-col items-center gap-1.5"
            >
              <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                {d.count}
              </span>
              <div className="flex h-24 w-full items-end">
                <div
                  className="w-full rounded-t-md bg-primary/80 transition-all"
                  style={{ height: `${Math.max(d.count > 0 ? 6 : 2, h)}%` }}
                  title={`${d.count} лид(ов)`}
                />
              </div>
              <span className="text-[10px] text-muted-foreground">
                {dayTick(d.date)}
              </span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/** 7-day trend of chat → messenger transitions, split Telegram vs WhatsApp. */
export function MessengerTrendChart({
  byDay,
}: {
  byDay: { date: string; telegram: number; whatsapp: number }[]
}) {
  const max = Math.max(
    1,
    ...byDay.map((d) => d.telegram + d.whatsapp),
  )
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Переходы в мессенджеры за 7 дней</h2>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-sky-500" /> Telegram
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-emerald-500" /> WhatsApp
          </span>
        </div>
      </div>
      <div className="mt-5 flex items-end justify-between gap-2">
        {byDay.map((d) => {
          const sum = d.telegram + d.whatsapp
          const tgH = Math.round((d.telegram / max) * 100)
          const waH = Math.round((d.whatsapp / max) * 100)
          return (
            <div
              key={d.date}
              className="flex flex-1 flex-col items-center gap-1.5"
            >
              <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                {sum || ''}
              </span>
              <div className="flex h-24 w-full flex-col justify-end overflow-hidden rounded-t-md bg-muted/40">
                <div
                  className="w-full bg-sky-500/90"
                  style={{ height: `${tgH}%` }}
                  title={`Telegram: ${d.telegram}`}
                />
                <div
                  className="w-full bg-emerald-500/90"
                  style={{ height: `${waH}%` }}
                  title={`WhatsApp: ${d.whatsapp}`}
                />
              </div>
              <span className="text-[10px] text-muted-foreground">
                {dayTick(d.date)}
              </span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/** Conversion goals with completion counts. */
export function ConversionGoalsSummary({
  goals,
}: {
  goals: {
    id: string
    name: string
    messenger: 'any' | 'telegram' | 'whatsapp'
    active: boolean
    completions: number
  }[]
}) {
  const messengerLabel = (m: 'any' | 'telegram' | 'whatsapp') =>
    m === 'telegram'
      ? 'Telegram'
      : m === 'whatsapp'
        ? 'WhatsApp'
        : 'Любой мессенджер'

  return (
    <Card className="p-5">
      <h2 className="font-medium">Конверсионные цели</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Достижения целей по переходам из чата в мессенджеры.
      </p>
      {goals.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Цели ещё не настроены.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {goals.map((g) => (
            <li
              key={g.id}
              className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                  {g.messenger === 'whatsapp' ? (
                    <Phone className="size-4 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Send className="size-4 text-sky-600 dark:text-sky-400" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {g.name}
                    {!g.active ? (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        (выключена)
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {messengerLabel(g.messenger)}
                  </p>
                </div>
              </div>
              <span className="shrink-0 text-lg font-semibold tabular-nums">
                {g.completions}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
