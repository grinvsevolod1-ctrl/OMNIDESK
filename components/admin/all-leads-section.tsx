'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  FileSpreadsheet,
  Loader2,
  Search,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getLeadCardStatsAdminAction,
  listAllLeadsAdminAction,
  transferLeadAdminAction,
} from '@/app/actions/lead-cards'
import { exportLeadsExcelAction } from '@/app/actions/leads-export'
import { AdminLeadRow } from '@/components/admin/leads/admin-lead-row'
import { LeadsPagination } from '@/components/admin/leads/leads-pagination'
import { LeadsPeriodStats } from '@/components/admin/leads/leads-period-stats'
import { LeadsTrashDialog } from '@/components/admin/leads-trash-dialog'
import { LeadDetailPanel } from '@/components/curator/lead-detail-panel'
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
import type { CuratorWithLoad, LeadCard } from '@/lib/data/lead-cards'
import type { LeadCardStats } from '@/lib/data/lead-stats'
import { LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_STATUS_TONE } from '@/lib/lead-status'
import { mskDayKey } from '@/lib/time'
import { cn } from '@/lib/utils'

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
 * Admin overview of ALL transferred leads. Контейнер: состояние фильтров,
 * realtime-пуллинг и загрузка; строки таблицы (AdminLeadRow), статистика
 * (LeadsPeriodStats) и пагинация (LeadsPagination) — мемоизированные
 * подкомпоненты, чтобы 5-секундный пуллинг не перерисовывал весь список.
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
  // Компактный поиск: раскрывается на фокусе или пока есть текст,
  // соседние элементы в этот момент ужимаются.
  const [searchFocused, setSearchFocused] = useState(false)
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

  // reload стабилен (useCallback + чтение фильтров из ref) — его можно
  // безопасно передавать в мемоизированные подкомпоненты.
  const reload = useCallback(
    (next: {
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
    }) => {
      const cur = filtersRef.current
      const f = {
        curatorId: next.curatorId ?? cur.curatorId,
        status: next.status ?? cur.status,
        search: next.search ?? cur.search,
        sort: next.sort ?? cur.sort,
        orphanedOnly: next.orphanedOnly ?? cur.orphanedOnly,
        offset: next.offset ?? 0,
        preset: next.preset ?? cur.preset,
        day: next.day ?? cur.day,
        from: next.from ?? cur.from,
        to: next.to ?? cur.to,
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
    },
    [],
  )

  // Стабильные колбэки для мемоизированных строк.
  const refreshRow = useCallback(() => {
    reload({ offset: filtersRef.current.offset })
  }, [reload])

  // Полная карточка лида: клик по свободному месту строки — как у
  // менеджера по кадрам (комментарии, история, вложения, статус).
  const [openedLeadId, setOpenedLeadId] = useState<string | null>(null)
  const openLead = useCallback((id: string) => setOpenedLeadId(id), [])

  const transfer = useCallback(
    (leadId: string, toCuratorId: string) => {
      startTransition(async () => {
        const res = await transferLeadAdminAction({
          leadCardId: leadId,
          curatorId: toCuratorId,
        })
        if (res.ok) {
          toast.success(res.message)
          reload({ offset: filtersRef.current.offset })
        } else {
          toast.error(res.message)
        }
      })
    },
    [reload],
  )

  // Realtime-поиск: перезагрузка через 350мс после остановки ввода, без Enter.
  const searchInitRef = useRef(true)
  useEffect(() => {
    if (searchInitRef.current) {
      searchInitRef.current = false
      return
    }
    const t = setTimeout(() => reload({ search }), 350)
    return () => clearTimeout(t)
  }, [search, reload])

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

  const searchExpanded = searchFocused || search.length > 0

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
        <LeadsPeriodStats stats={stats} today={today} />
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
            className={cn(
              'h-9 transition-all duration-300',
              searchExpanded ? 'max-w-44' : 'max-w-64',
            )}
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

        {/* Единый поиск: дата ДД.ММ.ГГГГ / ФИО / телефон / @username / город /
            регион. Компактный по умолчанию — плавно раскрывается на фокусе
            (или пока есть текст), а соседние элементы ужимаются. */}
        <div
          className={cn(
            'relative min-w-0 transition-all duration-300 ease-out',
            searchExpanded ? 'flex-1 basis-64' : 'flex-none basis-44',
          )}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          {/* Поиск в реальном времени: debounce 350мс, Enter не нужен. */}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder={
              searchExpanded
                ? 'Дата, ФИО, телефон, @username, город, регион…'
                : 'Поиск'
            }
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
          {/* Пока поиск раскрыт — только иконки, чтобы всё влезло в строку */}
          {!searchExpanded ? (sort === 'newest' ? 'Новые' : 'Старые') : null}
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
          {!searchExpanded ? 'Excel' : null}
        </Button>

        <LeadsTrashDialog onChanged={refreshRow} />
      </div>

      <Card className="overflow-hidden">
        {leads.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {pending ? 'Загрузка…' : 'Ничего не найдено'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {leads.map((lead) => (
              <AdminLeadRow
                key={lead.id}
                lead={lead}
                curators={curators}
                isFresh={freshIds.has(lead.id)}
                pending={pending}
                onRefresh={refreshRow}
                onTransfer={transfer}
                onOpen={openLead}
              />
            ))}
          </ul>
        )}
      </Card>

      {total > PAGE_SIZE ? (
        <LeadsPagination
          total={total}
          offset={offset}
          pageSize={PAGE_SIZE}
          pending={pending}
          onPage={(nextOffset) => reload({ offset: nextOffset })}
        />
      ) : null}

      {/* Полная карточка лида — та же панель, что у менеджера по кадрам,
          в админ-режиме (статус через админский action, виден владелец). */}
      {openedLeadId ? (
        <LeadDetailPanel
          leadId={openedLeadId}
          variant="admin"
          onClose={() => setOpenedLeadId(null)}
          onUpdated={refreshRow}
        />
      ) : null}
    </section>
  )
}
