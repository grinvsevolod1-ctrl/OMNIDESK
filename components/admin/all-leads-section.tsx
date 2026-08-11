'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react'
import { toast } from 'sonner'
import {
  getLeadCardStatsAdminAction,
  listAllLeadsAdminAction,
  transferLeadAdminAction,
} from '@/app/actions/lead-cards'
import { exportLeadsExcelAction } from '@/app/actions/leads-export'
import { AdminLeadRow } from '@/components/admin/leads/admin-lead-row'
import { LeadsFilterBar } from '@/components/admin/leads/leads-filter-bar'
import { LeadsPagination } from '@/components/admin/leads/leads-pagination'
import { LeadsPeriodFilter } from '@/components/admin/leads/leads-period-filter'
import { LeadsPeriodStats } from '@/components/admin/leads/leads-period-stats'
import {
  type PeriodPreset,
  presetRange,
  shiftDay,
} from '@/components/admin/leads/period-range'
import { downloadBase64Xlsx } from '@/components/admin/leads/xlsx-download'
import { LeadDetailPanel } from '@/components/curator/lead-detail-panel'
import { Card } from '@/components/ui/card'
import type { CuratorWithLoad, LeadCard } from '@/lib/data/lead-cards'
import type { LeadCardStats } from '@/lib/data/lead-stats'
import { mskDayKey } from '@/lib/time'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 20

/**
 * Admin overview of ALL transferred leads. Контейнер: состояние фильтров,
 * realtime-пуллинг и загрузка; фильтр периода (LeadsPeriodFilter), панель
 * фильтров (LeadsFilterBar), строки таблицы (AdminLeadRow), статистика
 * (LeadsPeriodStats) и пагинация (LeadsPagination) — подкомпоненты, чтобы
 * 5-секундный пуллинг не перерисовывал весь список.
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
  const exportExcel = useCallback(() => {
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
  }, [curatorId, status, search, orphanedOnly, preset, day, from, to, sort, startExport])

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

      {/* Пресеты периода: статистика по датам (сегодня / период / день) */}
      <LeadsPeriodFilter
        preset={preset}
        day={day}
        from={from}
        to={to}
        today={today}
        onPreset={(p) => {
          setPreset(p)
          reload({ preset: p })
        }}
        onDay={(v) => {
          setDay(v)
          reload({ day: v })
        }}
        onFrom={(v) => {
          setFrom(v)
          reload({ from: v })
        }}
        onTo={(v) => {
          setTo(v)
          reload({ to: v })
        }}
      />

      {/* Статистика за выбранный период */}
      {stats && preset !== 'all' ? (
        <LeadsPeriodStats stats={stats} today={today} />
      ) : null}

      <LeadsFilterBar
        curatorId={curatorId}
        status={status}
        search={search}
        sort={sort}
        orphanedOnly={orphanedOnly}
        exporting={exporting}
        searchExpanded={searchExpanded}
        curators={curators}
        onCuratorChange={(v) => {
          setCuratorId(v)
          reload({ curatorId: v })
        }}
        onStatusChange={(v) => {
          setStatus(v)
          reload({ status: v })
        }}
        onSearchChange={setSearch}
        onSearchFocus={() => setSearchFocused(true)}
        onSearchBlur={() => setSearchFocused(false)}
        onToggleSort={() => {
          const next = sort === 'newest' ? 'oldest' : 'newest'
          setSort(next)
          reload({ sort: next })
        }}
        onExport={exportExcel}
        onTrashChanged={refreshRow}
      />

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
