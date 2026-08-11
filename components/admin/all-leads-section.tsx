'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import {
  ArrowDownWideNarrow,
  ArrowRightLeft,
  ArrowUpNarrowWide,
  AtSign,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Loader2,
  Search,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getLeadCardStatsAdminAction,
  listAllLeadsAdminAction,
  transferLeadAdminAction,
} from '@/app/actions/lead-cards'
import { exportLeadsExcelAction } from '@/app/actions/leads-export'
import {
  CityInlineEditor,
  DeleteLeadButton,
  StatusInlineEditor,
  TextInlineEditor,
} from '@/components/admin/lead-inline-edit'
import { LeadsTrashDialog } from '@/components/admin/leads-trash-dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { CuratorWithLoad, LeadCard } from '@/lib/data/lead-cards'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
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

/** Скачивание готового .xlsx из base64 (server action не умеет стримить файл). */
function downloadBase64Xlsx(base64: string, fileName: string) {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

const PAGE_SIZE = 20

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
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [orphanedOnly, setOrphanedOnly] = useState(false)
  const [preset, setPreset] = useState<PeriodPreset>('all')
  const [day, setDay] = useState(today)
  const [from, setFrom] = useState(shiftDay(today, -6))
  const [to, setTo] = useState(today)
  const [stats, setStats] = useState<LeadCardStats | null>(null)
  const [pending, startTransition] = useTransition()
  const [exporting, startExport] = useTransition()

  // Realtime: id лидов, появившихся при фоновом пуллинге, — для подсветки.
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set())
  const knownIdsRef = useRef<Set<string>>(
    new Set(initialLeads.map((l) => l.id)),
  )

  // Текущие фильтры в ref (синхронизация в эффекте, по правилу
  // react-hooks/refs) — фоновый пуллинг всегда видит актуальные значения
  // без пересоздания интервала на каждый ввод.
  const filtersRef = useRef({
    curatorId,
    status,
    search,
    sort,
    orphanedOnly,
    offset,
    preset,
    day,
    from,
    to,
  })
  useEffect(() => {
    filtersRef.current = {
      curatorId,
      status,
      search,
      sort,
      orphanedOnly,
      offset,
      preset,
      day,
      from,
      to,
    }
  }, [
    curatorId,
    status,
    search,
    sort,
    orphanedOnly,
    offset,
    preset,
    day,
    from,
    to,
  ])

  function reload(next: {
    curatorId?: string
    status?: string
    search?: string
    sort?: 'newest' | 'oldest'
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
      search: next.search ?? search,
      sort: next.sort ?? sort,
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
            search: f.search || null,
            sort: f.sort,
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
        // Ручная перезагрузка — все текущие лиды считаются известными.
        knownIdsRef.current = new Set(res.leads.map((l) => l.id))
        setFreshIds(new Set())
      } catch {
        toast.error('Не удалось загрузить лиды')
      }
    })
  }

  // Realtime-поиск: перезагрузка через 350мс после остановки ввода, без Enter.
  const searchInitRef = useRef(true)
  useEffect(() => {
    if (searchInitRef.current) {
      searchInitRef.current = false
      return
    }
    const t = setTimeout(() => reload({ search }), 350)
    return () => clearTimeout(t)
    // reload намеренно вне deps: пересоздаётся каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Фоновый пуллинг каждые 5с: список обновляется сам, новые лиды
  // подсвечиваются. Без startTransition — никаких спиннеров при фоне.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (document.visibilityState === 'hidden') return
      const f = filtersRef.current
      const range = presetRange(f.preset, f.day, f.from, f.to)
      try {
        const res = await listAllLeadsAdminAction({
          curatorId: f.curatorId || null,
          status: f.status || null,
          search: f.search || null,
          sort: f.sort,
          from: range.from,
          to: range.to,
          orphanedOnly: f.orphanedOnly,
          limit: PAGE_SIZE,
          offset: f.offset,
        })
        if (cancelled) return
        const arrived = res.leads
          .map((l) => l.id)
          .filter((id) => !knownIdsRef.current.has(id))
        setLeads(res.leads)
        setTotal(res.total)
        for (const id of arrived) knownIdsRef.current.add(id)
        if (arrived.length > 0) {
          setFreshIds((prev) => {
            const next = new Set(prev)
            for (const id of arrived) next.add(id)
            return next
          })
          // Подсветка гаснет через 6 секунд.
          setTimeout(() => {
            if (cancelled) return
            setFreshIds((prev) => {
              const next = new Set(prev)
              for (const id of arrived) next.delete(id)
              return next
            })
          }, 6000)
        }
      } catch {
        // Фоновая ошибка — молча, следующий тик повторит.
      }
    }
    const interval = setInterval(tick, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  /** Выгрузка текущей выборки (все страницы, без пагинации) в .xlsx. */
  function exportExcel() {
    const range = presetRange(preset, day, from, to)
    startExport(async () => {
      const res = await exportLeadsExcelAction({
        curatorId: curatorId || null,
        status: status || null,
        search: search || null,
        orphanedOnly,
        from: range.from,
        to: range.to,
        sort,
      })
      if (res.ok && res.base64 && res.fileName) {
        downloadBase64Xlsx(res.base64, res.fileName)
        toast.success(`Выгружено лидов: ${res.rows}`)
      } else {
        toast.error(res.message ?? 'Не удалось выгрузить')
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
            Все переданные лиды по всем менеджерам по кадрам. Всего: {total}.
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
            Без менеджера по кадрам: {orphanedCount}
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
        <Select
          value={curatorId}
          onValueChange={(v) => {
            const next = (v as string) ?? ''
            setCuratorId(next)
            reload({ curatorId: next })
          }}
          disabled={orphanedOnly}
        >
          <SelectTrigger
            className="h-9 max-w-64"
            aria-label="Фильтр по менеджеру по кадрам"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-auto min-w-56">
            <SelectItem value="">Все менеджеры по кадрам</SelectItem>
            {curators.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate">{c.name}</span>
                  {c.cities?.length || c.city ? (
                    <span className="max-w-40 truncate text-xs text-muted-foreground">
                      {c.cities?.length ? c.cities.join(', ') : c.city}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={status}
          onValueChange={(v) => {
            const next = (v as string) ?? ''
            setStatus(next)
            reload({ status: next })
          }}
        >
          <SelectTrigger className="h-9" aria-label="Фильтр по статусу">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-auto min-w-44">
            <SelectItem value="">Все статусы</SelectItem>
            <SelectItem value="none">Без статуса</SelectItem>
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

        {/* Единый поиск: дата ДД.ММ.ГГГГ / ФИО / телефон / @username / город / регион */}
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          {/* Поиск в реальном времени: debounce 350мс, Enter не нужен. */}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск: дата, ФИО, телефон, @username, город, регион…"
            className="h-9 pl-8 pr-8"
            aria-label="Поиск по лидам"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Очистить поиск"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const next = sort === 'newest' ? 'oldest' : 'newest'
            setSort(next)
            reload({ sort: next })
          }}
          aria-label="Переключить сортировку"
          title={sort === 'newest' ? 'Сначала новые' : 'Сначала старые'}
        >
          {sort === 'newest' ? (
            <ArrowDownWideNarrow className="size-3.5" />
          ) : (
            <ArrowUpNarrowWide className="size-3.5" />
          )}
          {sort === 'newest' ? 'Новые' : 'Старые'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={exporting}
          onClick={exportExcel}
          aria-label="Выгрузить в Excel"
          title="Выгрузить текущую выборку в Excel"
        >
          {exporting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FileSpreadsheet className="size-3.5" />
          )}
          Excel
        </Button>

        <LeadsTrashDialog onChanged={() => reload({ offset })} />
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
              const refresh = () => reload({ offset })
              const isFresh = freshIds.has(lead.id)
              return (
                <li
                  key={lead.id}
                  className={cn(
                    'flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors duration-1000 sm:px-5',
                    // Новый лид, появившийся при фоновом обновлении, —
                    // плавная подсветка на несколько секунд.
                    isFresh &&
                      'bg-primary/10 duration-150 animate-in fade-in slide-in-from-top-2',
                  )}
                >
                  <div className="min-w-0 flex-1 basis-48">
                    {/* ФИО, должность, телефон редактируются кликом по значению */}
                    <TextInlineEditor
                      lead={lead}
                      field="full_name"
                      label="ФИО"
                      display={lead.fullName || 'Без имени'}
                      className="text-sm font-medium"
                      onSaved={refresh}
                    />
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <TextInlineEditor
                        lead={lead}
                        field="vacancy"
                        label="Должность"
                        display={lead.vacancy}
                        placeholder="Курьер, водитель…"
                        onSaved={refresh}
                      />
                      <span aria-hidden>·</span>
                      <TextInlineEditor
                        lead={lead}
                        field="phone"
                        label="Телефон"
                        display={lead.phone}
                        placeholder="+7…"
                        onSaved={refresh}
                      />
                      {lead.telegramUsername ? (
                        <a
                          href={`https://t.me/${lead.telegramUsername}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-primary transition-opacity hover:opacity-75"
                          title="Открыть чат в Telegram"
                        >
                          <AtSign className="size-3" />
                          {lead.telegramUsername}
                        </a>
                      ) : null}
                    </div>
                  </div>

                  <CityInlineEditor lead={lead} onSaved={refresh} />

                  {lead.curatorName ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="cursor-default text-xs text-muted-foreground">
                            {lead.curatorName}
                          </span>
                        }
                      />
                      <TooltipContent side="top">
                        Менеджер по кадрам
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-destructive/15 text-destructive"
                    >
                      Без менеджера по кадрам
                    </Badge>
                  )}

                  {needs ? (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    >
                      Нужно обновить
                    </Badge>
                  ) : null}
                  <StatusInlineEditor lead={lead} onSaved={refresh} />

                  {lead.transferredAt ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="cursor-default text-xs text-muted-foreground">
                            {formatDateTime(lead.transferredAt)}
                          </span>
                        }
                      />
                      <TooltipContent side="top">Дата передачи</TooltipContent>
                    </Tooltip>
                  ) : null}

                  <div className="flex items-center">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Передать"
                            disabled={pending}
                          >
                            <ArrowRightLeft className="size-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="min-w-52">
                        <DropdownMenuLabel>Передать</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {curators.filter((c) => c.id !== lead.curatorId)
                          .length === 0 ? (
                          <DropdownMenuItem disabled>
                            Нет доступных сотрудников
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
                    <DeleteLeadButton lead={lead} onDeleted={refresh} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {total > PAGE_SIZE ? (
        <Pagination
          total={total}
          offset={offset}
          pageSize={PAGE_SIZE}
          pending={pending}
          onPage={(nextOffset) => reload({ offset: nextOffset })}
        />
      ) : null}
    </section>
  )
}

/** Номера страниц с многоточиями: 1 … 4 [5] 6 … 75 — рассчитано на 1500+ лидов. */
function Pagination({
  total,
  offset,
  pageSize,
  pending,
  onPage,
}: {
  total: number
  offset: number
  pageSize: number
  pending: boolean
  onPage: (offset: number) => void
}) {
  const pageCount = Math.ceil(total / pageSize)
  const current = Math.floor(offset / pageSize) + 1

  // Всегда: первая, последняя, текущая ± 1; между разрывами — многоточие.
  const pages: (number | 'gap')[] = []
  let prev = 0
  for (let p = 1; p <= pageCount; p++) {
    const keep = p === 1 || p === pageCount || Math.abs(p - current) <= 1
    if (!keep) continue
    if (prev && p - prev > 1) pages.push('gap')
    pages.push(p)
    prev = p
  }

  return (
    <nav
      className="flex flex-wrap items-center justify-center gap-1.5"
      aria-label="Страницы списка лидов"
    >
      <Button
        variant="outline"
        size="icon-sm"
        disabled={pending || current === 1}
        onClick={() => onPage((current - 2) * pageSize)}
        aria-label="Предыдущая страница"
      >
        <ChevronLeft className="size-4" />
      </Button>
      {pages.map((p, i) =>
        p === 'gap' ? (
          <span
            key={`gap-${i}`}
            className="px-1 text-sm text-muted-foreground"
            aria-hidden
          >
            …
          </span>
        ) : (
          <Button
            key={p}
            variant={p === current ? 'default' : 'outline'}
            size="icon-sm"
            disabled={pending}
            onClick={() => onPage((p - 1) * pageSize)}
            aria-label={`Страница ${p}`}
            aria-current={p === current ? 'page' : undefined}
          >
            {p}
          </Button>
        ),
      )}
      <Button
        variant="outline"
        size="icon-sm"
        disabled={pending || current === pageCount}
        onClick={() => onPage(current * pageSize)}
        aria-label="Следующая страница"
      >
        <ChevronRight className="size-4" />
      </Button>
      <span className="ml-2 text-xs text-muted-foreground">
        {offset + 1}–{Math.min(offset + pageSize, total)} из {total}
      </span>
    </nav>
  )
}
