'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import {
  ArrowRightLeft,
  CalendarDays,
  Loader2,
  MapPin,
  RefreshCw,
  UserPlus,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getMyLeadCardStatsAction,
  listMyLeadCardsAction,
} from '@/app/actions/lead-cards'
import { StatCard } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { LeadCard } from '@/lib/data/lead-cards'
import type { LeadCardStats } from '@/lib/data/lead-stats'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  leadStatusLabel,
} from '@/lib/lead-status'
import { APP_TIME_ZONE, mskDayKey } from '@/lib/time'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50

type PeriodPreset = 'today' | '7d' | '30d' | 'day' | 'range'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

/** Resolve a preset into an inclusive MSK from/to pair. */
function presetRange(
  preset: PeriodPreset,
  day: string,
  from: string,
  to: string,
): { from: string; to: string } {
  const today = mskDayKey(new Date())
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: shiftDay(today, -6), to: today }
    case '30d':
      return { from: shiftDay(today, -29), to: today }
    case 'day':
      return { from: day, to: day }
    case 'range':
      return { from, to }
  }
}

/**
 * Manager «Мои лиды»: only this manager's lead cards with stats for today /
 * a period / any single day, plus a status filter including «Передан».
 */
export function ManagerLeadsView({
  initialLeads,
  initialTotal,
  initialStats,
}: {
  initialLeads: LeadCard[]
  initialTotal: number
  initialStats: LeadCardStats
}) {
  const today = mskDayKey(new Date())

  const [preset, setPreset] = useState<PeriodPreset>('7d')
  const [day, setDay] = useState(today)
  const [from, setFrom] = useState(shiftDay(today, -6))
  const [to, setTo] = useState(today)
  const [status, setStatus] = useState<string>('')

  const [leads, setLeads] = useState(initialLeads)
  const [total, setTotal] = useState(initialTotal)
  const [offset, setOffset] = useState(0)
  const [stats, setStats] = useState(initialStats)
  const [pending, startTransition] = useTransition()

  const range = useMemo(
    () => presetRange(preset, day, from, to),
    [preset, day, from, to],
  )

  const reload = useCallback(
    (nextOffset = 0) => {
      startTransition(async () => {
        try {
          const [list, st] = await Promise.all([
            listMyLeadCardsAction({
              from: range.from,
              to: range.to,
              status: status || null,
              limit: PAGE_SIZE,
              offset: nextOffset,
            }),
            getMyLeadCardStatsAction({ from: range.from, to: range.to }),
          ])
          setLeads(list.leads)
          setTotal(list.total)
          setStats(st)
          setOffset(nextOffset)
        } catch {
          toast.error('Не удалось загрузить лиды')
        }
      })
    },
    [range.from, range.to, status],
  )

  // Refetch whenever the resolved period or the status filter changes.
  // The very first render already has server-fetched data for the default
  // «7 дней» window — skip the redundant round-trip.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    if (!hydrated) {
      setHydrated(true)
      return
    }
    reload(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload identity covers deps
  }, [range.from, range.to, status])

  const presetButtons: { key: PeriodPreset; label: string }[] = [
    { key: 'today', label: 'Сегодня' },
    { key: '7d', label: '7 дней' },
    { key: '30d', label: '30 дней' },
    { key: 'day', label: 'День' },
    { key: 'range', label: 'Период' },
  ]

  return (
    <div className="flex flex-col gap-6">
      {/* Period + status filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/30 p-1">
          {presetButtons.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm transition-colors',
                preset === p.key
                  ? 'bg-background font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'day' ? (
          <Input
            type="date"
            value={day}
            max={today}
            onChange={(e) => setDay(e.target.value || today)}
            className="h-9 w-40"
            aria-label="Выбрать день"
          />
        ) : null}

        {preset === 'range' ? (
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value || from)}
              className="h-9 w-40"
              aria-label="Начало периода"
            />
            <span className="text-sm text-muted-foreground">—</span>
            <Input
              type="date"
              value={to}
              max={today}
              onChange={(e) => setTo(e.target.value || to)}
              className="h-9 w-40"
              aria-label="Конец периода"
            />
          </div>
        ) : null}

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2.5 text-sm"
          aria-label="Фильтр по статусу"
        >
          <option value="">Все лиды</option>
          <option value="transferred">Передан куратору</option>
          <option value="not_transferred">Не передан</option>
          <option value="none">Без статуса куратора</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {LEAD_STATUS_LABELS[s]}
            </option>
          ))}
        </select>

        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => reload(offset)}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Обновить
        </Button>
      </div>

      {/* Stats for the selected period */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Статистика {stats.from === stats.to
            ? `за ${stats.from === today ? 'сегодня' : stats.from}`
            : `за период ${stats.from} — ${stats.to}`}
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Карточек создано"
            value={stats.created}
            icon={UserPlus}
            hint="за выбранный период"
          />
          <StatCard
            label="Передано куратору"
            value={stats.transferred}
            icon={ArrowRightLeft}
            hint="за выбранный период"
          />
          <StatCard
            label="Создано сегодня"
            value={stats.createdToday}
            icon={CalendarDays}
            hint="независимо от периода"
          />
          <StatCard
            label="Передано сегодня"
            value={stats.transferredToday}
            icon={Users}
            hint="независимо от периода"
          />
        </div>

        {Object.keys(stats.byStatus).length > 0 || stats.noStatus > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {LEAD_STATUSES.filter((s) => (stats.byStatus[s] ?? 0) > 0).map(
              (s) => {
                const tone = LEAD_STATUS_TONE[s]
                return (
                  <Badge
                    key={s}
                    variant="outline"
                    className={cn(
                      'gap-1.5 border-transparent',
                      tone.bg,
                      tone.text,
                    )}
                  >
                    <span className={cn('size-1.5 rounded-full', tone.dot)} />
                    {LEAD_STATUS_LABELS[s]}: {stats.byStatus[s]}
                  </Badge>
                )
              },
            )}
            {stats.noStatus > 0 ? (
              <Badge
                variant="outline"
                className="border-transparent bg-muted text-muted-foreground"
              >
                Без статуса: {stats.noStatus}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Lead list */}
      <Card className="overflow-hidden">
        {leads.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {pending ? 'Загрузка…' : 'За выбранный период лидов нет'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {leads.map((lead) => {
              const tone = lead.status ? LEAD_STATUS_TONE[lead.status] : null
              return (
                <li
                  key={lead.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:px-5"
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate text-sm font-medium">
                      {lead.fullName || 'Без имени'}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[lead.vacancy, lead.phone].filter(Boolean).join(' · ') ||
                        '—'}
                    </p>
                  </div>

                  {lead.city ? (
                    <Badge
                      variant="outline"
                      className="gap-1 border-transparent bg-muted text-muted-foreground"
                    >
                      <MapPin className="size-3" />
                      {lead.city}
                    </Badge>
                  ) : null}

                  {lead.transferredAt ? (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                    >
                      Передан{lead.curatorName ? `: ${lead.curatorName}` : ''}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-muted text-muted-foreground"
                    >
                      Не передан
                    </Badge>
                  )}

                  {tone && lead.status ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        'gap-1.5 border-transparent',
                        tone.bg,
                        tone.text,
                      )}
                    >
                      <span className={cn('size-1.5 rounded-full', tone.dot)} />
                      {leadStatusLabel(lead.status)}
                    </Badge>
                  ) : null}

                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(
                      lead.transferredAt && status === 'transferred'
                        ? lead.transferredAt
                        : lead.createdAt,
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            disabled={pending || offset === 0}
            onClick={() => reload(Math.max(offset - PAGE_SIZE, 0))}
          >
            Назад
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} из {total}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || offset + PAGE_SIZE >= total}
            onClick={() => reload(offset + PAGE_SIZE)}
          >
            Вперёд
          </Button>
        </div>
      ) : null}
    </div>
  )
}
