'use client'

import { useState, useTransition } from 'react'
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
  getLeadCardStatsAdminAction,
  listAllLeadsAdminAction,
  transferLeadAdminAction,
} from '@/app/actions/lead-cards'
import { StatCard } from '@/components/page-parts'
import type { LeadCardStats } from '@/lib/data/lead-stats'
import { mskDayKey } from '@/lib/time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { CuratorWithLoad, LeadCard } from '@/lib/data/lead-cards'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  leadStatusLabel,
  leadNeedsDailyStatus,
} from '@/lib/lead-status'
import { APP_TIME_ZONE } from '@/lib/time'
import { cn } from '@/lib/utils'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

const PAGE_SIZE = 50

type PeriodPreset = 'all' | 'today' | '7d' | '30d' | 'day' | 'range'

function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

/** Resolve a preset into an inclusive MSK from/to pair (nulls = no limit). */
function presetRange(
  preset: PeriodPreset,
  day: string,
  from: string,
  to: string,
): { from: string | null; to: string | null } {
  const today = mskDayKey(new Date())
  switch (preset) {
    case 'all':
      return { from: null, to: null }
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
 * Admin overview of ALL transferred leads: filters by curator/status/city,
 * an "orphaned" mode surfacing leads whose curator was deleted, and a
 * reassign action for every row.
 */
export function AllLeadsSection({
  initialLeads,
  initialTotal,
  orphanedCount,
  curators,
}: {
  initialLeads: LeadCard[]
  initialTotal: number
  orphanedCount: number
  curators: CuratorWithLoad[]
}) {
  const today = mskDayKey(new Date())

  const [leads, setLeads] = useState(initialLeads)
  const [total, setTotal] = useState(initialTotal)
  const [offset, setOffset] = useState(0)
  const [curatorId, setCuratorId] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [city, setCity] = useState('')
  const [orphanedOnly, setOrphanedOnly] = useState(false)
  const [preset, setPreset] = useState<PeriodPreset>('all')
  const [day, setDay] = useState(today)
  const [from, setFrom] = useState(shiftDay(today, -6))
  const [to, setTo] = useState(today)
  const [stats, setStats] = useState<LeadCardStats | null>(null)
  const [pending, startTransition] = useTransition()

  function reload(next: {
    curatorId?: string
    status?: string
    city?: string
    orphanedOnly?: boolean
    offset?: number
    preset?: PeriodPreset
    day?: string
    from?: string
    to?: string
  }) {
    const f = {
      curatorId: next.curatorId ?? curatorId,
      status: next.status ?? status,
      city: next.city ?? city,
      orphanedOnly: next.orphanedOnly ?? orphanedOnly,
      offset: next.offset ?? 0,
      preset: next.preset ?? preset,
      day: next.day ?? day,
      from: next.from ?? from,
      to: next.to ?? to,
    }
    const range = presetRange(f.preset, f.day, f.from, f.to)
    startTransition(async () => {
      try {
        const [res, st] = await Promise.all([
          listAllLeadsAdminAction({
            curatorId: f.curatorId || null,
            status: f.status || null,
            city: f.city || null,
            from: range.from,
            to: range.to,
            orphanedOnly: f.orphanedOnly,
            limit: PAGE_SIZE,
            offset: f.offset,
          }),
          f.preset === 'all'
            ? Promise.resolve(null)
            : getLeadCardStatsAdminAction({
                from: range.from,
                to: range.to,
                curatorId: f.orphanedOnly ? null : f.curatorId || null,
              }),
        ])
        setLeads(res.leads)
        setTotal(res.total)
        setOffset(f.offset)
        setStats(st)
      } catch {
        toast.error('Не удалось загрузить лиды')
      }
    })
  }

  function transfer(leadId: string, toCuratorId: string) {
    startTransition(async () => {
      const res = await transferLeadAdminAction({
        leadCardId: leadId,
        curatorId: toCuratorId,
      })
      if (res.ok) {
        toast.success(res.message)
        reload({ offset })
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Все лиды</h2>
          <p className="text-sm text-muted-foreground">
            Все переданные лиды по всем кураторам. Всего: {total}.
          </p>
        </div>
        {orphanedCount > 0 ? (
          <button
            type="button"
            onClick={() => {
              const next = !orphanedOnly
              setOrphanedOnly(next)
              reload({ orphanedOnly: next })
            }}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              orphanedOnly
                ? 'border-transparent bg-destructive/15 text-destructive'
                : 'border-destructive/40 text-destructive hover:bg-destructive/10',
            )}
          >
            Без куратора: {orphanedCount}
          </button>
        ) : null}
      </div>

      {/* Period presets: statistics by dates (today / period / single day) */}
      <div className="flex flex-wrap items-center gap-2">
        {/* На узких экранах пресеты уходят в горизонтальный скролл */}
        <div className="scrollbar-thin -mx-1 max-w-full overflow-x-auto px-1 sm:mx-0 sm:px-0">
          <div className="flex w-max items-center gap-1 rounded-xl border border-border bg-muted/30 p-1">
            {(
              [
                { key: 'all', label: 'Всё время' },
                { key: 'today', label: 'Сегодня' },
                { key: '7d', label: '7 дней' },
                { key: '30d', label: '30 дней' },
                { key: 'day', label: 'День' },
                { key: 'range', label: 'Период' },
              ] as { key: PeriodPreset; label: string }[]
            ).map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  setPreset(p.key)
                  reload({ preset: p.key })
                }}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors',
                  preset === p.key
                    ? 'bg-background font-medium shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {preset === 'day' ? (
          <Input
            type="date"
            value={day}
            max={today}
            onChange={(e) => {
              const v = e.target.value || today
              setDay(v)
              reload({ day: v })
            }}
            className="h-9 w-40"
            aria-label="Выбрать день"
          />
        ) : null}

        {preset === 'range' ? (
          <div className="flex w-full items-center gap-1.5 sm:w-auto">
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(e) => {
                const v = e.target.value || from
                setFrom(v)
                reload({ from: v })
              }}
              className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none"
              aria-label="Начало периода"
            />
            <span className="shrink-0 text-sm text-muted-foreground">—</span>
            <Input
              type="date"
              value={to}
              max={today}
              onChange={(e) => {
                const v = e.target.value || to
                setTo(v)
                reload({ to: v })
              }}
              className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none"
              aria-label="Конец периода"
            />
          </div>
        ) : null}
      </div>

      {/* Stats for the selected period */}
      {stats && preset !== 'all' ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Карточек создано"
              value={stats.created}
              icon={UserPlus}
              hint={
                stats.from === stats.to
                  ? `за ${stats.from === today ? 'сегодня' : stats.from}`
                  : `${stats.from} — ${stats.to}`
              }
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
                      <span
                        className={cn('size-1.5 rounded-full', tone.dot)}
                      />
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
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={curatorId}
          onChange={(e) => {
            setCuratorId(e.target.value)
            reload({ curatorId: e.target.value })
          }}
          disabled={orphanedOnly}
          className="h-9 rounded-md border border-input bg-background px-2.5 text-sm"
          aria-label="Фильтр по куратору"
        >
          <option value="">Все кураторы</option>
          {curators.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.cities?.length
                ? ` — ${c.cities.join(', ')}`
                : c.city
                  ? ` — ${c.city}`
                  : ''}
            </option>
          ))}
        </select>

        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            reload({ status: e.target.value })
          }}
          className="h-9 rounded-md border border-input bg-background px-2.5 text-sm"
          aria-label="Фильтр по статусу"
        >
          <option value="">Все статусы</option>
          <option value="none">Без статуса</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {LEAD_STATUS_LABELS[s]}
            </option>
          ))}
        </select>

        <Input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              reload({ city })
            }
          }}
          placeholder="Город…"
          className="h-9 w-36"
          aria-label="Фильтр по городу"
        />

        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => reload({})}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Обновить
        </Button>
      </div>

      <Card className="overflow-hidden">
        {leads.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {pending ? 'Загрузка…' : 'Ничего не найдено'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {leads.map((lead) => {
              const needs = leadNeedsDailyStatus(lead)
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

                  {lead.curatorName ? (
                    <span className="text-xs text-muted-foreground">
                      {lead.curatorName}
                    </span>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-destructive/15 text-destructive"
                    >
                      Без куратора
                    </Badge>
                  )}

                  {needs ? (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    >
                      Нужно обновить
                    </Badge>
                  ) : tone && lead.status ? (
                    <Badge
                      variant="outline"
                      className={cn('gap-1.5 border-transparent', tone.bg, tone.text)}
                    >
                      <span className={cn('size-1.5 rounded-full', tone.dot)} />
                      {leadStatusLabel(lead.status)}
                    </Badge>
                  ) : null}

                  {lead.transferredAt ? (
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(lead.transferredAt)}
                    </span>
                  ) : null}

                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Передать куратору"
                          disabled={pending}
                        >
                          <ArrowRightLeft className="size-4" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" className="min-w-52">
                      <DropdownMenuLabel>Передать куратору</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {curators.filter((c) => c.id !== lead.curatorId).length ===
                      0 ? (
                        <DropdownMenuItem disabled>
                          Нет доступных кураторов
                        </DropdownMenuItem>
                      ) : (
                        curators
                          .filter((c) => c.id !== lead.curatorId)
                          .map((c) => (
                            <DropdownMenuItem
                              key={c.id}
                              onClick={() => transfer(lead.id, c.id)}
                            >
                              <span className="truncate">{c.name}</span>
                              <span className="ml-auto max-w-[50%] truncate text-xs text-muted-foreground">
                                {c.cities?.length
                                  ? c.cities.join(', ')
                                  : (c.city ?? '')}{' '}
                                · {c.activeLeads} лид.
                              </span>
                            </DropdownMenuItem>
                          ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
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
            onClick={() => reload({ offset: Math.max(offset - PAGE_SIZE, 0) })}
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
            onClick={() => reload({ offset: offset + PAGE_SIZE })}
          >
            Вперёд
          </Button>
        </div>
      ) : null}
    </section>
  )
}
