'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  ArrowRightLeft,
  CalendarDays,
  FileSpreadsheet,
  ListFilter,
  Loader2,
  UserPlus,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getMyLeadCardStatsAction,
  listMyLeadCardsAction,
} from '@/app/actions/lead-cards'
import { exportManagerLeadsExcelAction } from '@/app/actions/leads-export'
import { downloadBase64Xlsx } from '@/components/admin/leads/xlsx-download'
import { ManagerLeadDetailPanel } from '@/components/manager/manager-lead-detail-panel'
import { ManagerLeadRow } from '@/components/manager/manager-lead-row'
import { StatCard } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  LeadCardStats,
  ManagerLeadListItem,
} from '@/lib/data/lead-stats'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
} from '@/lib/lead-status'
import { useLeadEvents } from '@/lib/hooks/use-lead-events'
import { useSharedPoll } from '@/lib/hooks/use-shared-poll'
import { mskDayKey } from '@/lib/time'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50

type PeriodPreset = 'today' | '7d' | '30d' | 'day' | 'range'

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
  initialLeads: ManagerLeadListItem[]
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
  const [exporting, startExport] = useTransition()

  // Realtime: подсветка лидов, появившихся при фоновом пуллинге.
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set())
  const knownIdsRef = useRef<Set<string>>(
    new Set(initialLeads.map((l) => l.id)),
  )

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
          // Ручная перезагрузка — все текущие лиды считаются известными.
          knownIdsRef.current = new Set(list.leads.map((l) => l.id))
          setFreshIds(new Set())
        } catch {
          toast.error('Не удалось загрузить лиды')
        }
      })
    },
    [range.from, range.to, status],
  )

  // Выгрузка текущей выборки (период + статус) в Excel — как у админа и
  // менеджера по кадрам: server action собирает .xlsx, клиент скачивает.
  const exportExcel = useCallback(() => {
    startExport(async () => {
      const res = await exportManagerLeadsExcelAction({
        from: range.from,
        to: range.to,
        status: (status ||
          null) as Parameters<
          typeof exportManagerLeadsExcelAction
        >[0]['status'],
      })
      if (res.ok && res.base64 && res.fileName) {
        downloadBase64Xlsx(res.base64, res.fileName)
        toast.success(`Выгружено лидов: ${res.rows ?? 0}`)
      } else {
        toast.error(res.message ?? 'Ошибка выгрузки')
      }
    })
  }, [range.from, range.to, status])

  // Push + редкий poll-фолбэк: SSE-событие `lead` (миграция 127) мгновенно
  // пинает поллер через pokeSharedPoll, интервал растянут до 60с — страховка
  // на потерянный NOTIFY / отвалившийся SSE. Новые лиды подсвечиваются.
  const pollArgsRef = useRef({ range, status, offset })
  useEffect(() => {
    pollArgsRef.current = { range, status, offset }
  }, [range, status, offset])
  useLeadEvents('manager-leads')
  useSharedPoll('manager-leads', async () => {
    const a = pollArgsRef.current
    const [list, st] = await Promise.all([
      listMyLeadCardsAction({
        from: a.range.from,
        to: a.range.to,
        status: a.status || null,
        limit: PAGE_SIZE,
        offset: a.offset,
      }),
      getMyLeadCardStatsAction({ from: a.range.from, to: a.range.to }),
    ])
    const arrived = list.leads
      .map((l) => l.id)
      .filter((id) => !knownIdsRef.current.has(id))
    setLeads(list.leads)
    setTotal(list.total)
    setStats(st)
    for (const id of arrived) knownIdsRef.current.add(id)
    if (arrived.length > 0) {
      setFreshIds((prev) => {
        const next = new Set(prev)
        for (const id of arrived) next.add(id)
        return next
      })
      setTimeout(() => {
        setFreshIds((prev) => {
          const next = new Set(prev)
          for (const id of arrived) next.delete(id)
          return next
        })
      }, 6000)
    }
  }, 60_000)

  // Refetch whenever the resolved period or the status filter changes.
  // The very first render already has server-fetched data for the default
  // «7 дней» window — skip the redundant round-trip.
  const [openLeadId, setOpenLeadId] = useState<string | null>(null)
  // Стабильный колбэк для мемоизированных строк списка.
  const openLead = useCallback((id: string) => setOpenLeadId(id), [])
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true
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
        {/* На узких экранах пресеты уходят в горизонтальный скролл, не ломая сетку */}
        <div className="scrollbar-thin -mx-1 max-w-full overflow-x-auto px-1 sm:mx-0 sm:px-0">
          <div className="flex w-max items-center gap-1 rounded-xl border border-border bg-muted/30 p-1">
            {presetButtons.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
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
            onChange={(e) => setDay(e.target.value || today)}
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
              onChange={(e) => setFrom(e.target.value || from)}
              className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none"
              aria-label="Начало периода"
            />
            <span className="shrink-0 text-sm text-muted-foreground">—</span>
            <Input
              type="date"
              value={to}
              max={today}
              onChange={(e) => setTo(e.target.value || to)}
              className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none"
              aria-label="Конец периода"
            />
          </div>
        ) : null}

        <Select
          value={status}
          onValueChange={(v) => setStatus((v as string) ?? '')}
        >
          <SelectTrigger
            className="h-9 gap-2 font-medium"
            aria-label="Фильтр по статусу"
          >
            <ListFilter className="size-4 shrink-0 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-auto min-w-56">
            <SelectItem value="">Все лиды (по умолчанию)</SelectItem>
            <SelectItem value="transferred">
              Передан менеджеру по кадрам
            </SelectItem>
            <SelectItem value="not_transferred">Не передан</SelectItem>
            <SelectItem value="none">
              Без статуса менеджера по кадрам
            </SelectItem>
            {LEAD_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      LEAD_STATUS_TONE[s].dot,
                    )}
                  />
                  {LEAD_STATUS_LABELS[s]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Выгрузка текущей выборки (период + статус) в Excel */}
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          disabled={exporting}
          onClick={exportExcel}
          aria-label="Выгрузить в Excel"
          title="Выгрузить текущую выборку в Excel"
        >
          {exporting ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : (
            <FileSpreadsheet className="size-4 shrink-0" />
          )}
          Excel
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
            label="Передано менеджеру по кадрам"
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
            {leads.map((lead) => (
              <ManagerLeadRow
                key={lead.id}
                lead={lead}
                isFresh={freshIds.has(lead.id)}
                showTransferredDate={status === 'transferred'}
                onOpen={openLead}
              />
            ))}
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

      {openLeadId ? (
        <ManagerLeadDetailPanel
          leadId={openLeadId}
          onClose={() => {
            setOpenLeadId(null)
            // Менеджер по кадрам мог обновить статус, пока панель была открыта.
            reload(offset)
          }}
        />
      ) : null}
    </div>
  )
}
