'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  getLeadCardStatsAdminAction,
  listAllLeadsAdminAction,
  transferLeadAdminAction,
} from '@/app/actions/lead-cards'
import { exportLeadsExcelAction } from '@/app/actions/leads-export'
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value'
import { useSharedPoll } from '@/lib/hooks/use-shared-poll'
import type { LeadCard } from '@/lib/data/lead-cards'
import type { LeadCardStats } from '@/lib/data/lead-stats'
import { type PeriodPreset, presetRange, shiftDay } from './period-range'
import { downloadBase64Xlsx } from './xlsx-download'

export const LEADS_PAGE_SIZE = 20

/** Единый набор фильтров выборки лидов (без пагинации). */
export interface LeadsFilters {
  curatorId: string
  status: string
  search: string
  sort: 'newest' | 'oldest'
  orphanedOnly: boolean
  preset: PeriodPreset
  day: string
  from: string
  to: string
}

/**
 * Вся клиентская логика раздела «Все лиды»: единое состояние фильтров,
 * пагинация, realtime-пуллинг (5с) с подсветкой новых лидов, debounce-поиск,
 * выгрузка в xlsx и передача лида. Контейнер-компонент остаётся
 * презентационным и лишь раскладывает возвращаемые значения по подкомпонентам.
 */
export function useLeadsData({
  initialLeads,
  initialTotal,
  today,
}: {
  initialLeads: LeadCard[]
  initialTotal: number
  today: string
}) {
  const [leads, setLeads] = useState(initialLeads)
  const [total, setTotal] = useState(initialTotal)
  const [offset, setOffset] = useState(0)
  const [stats, setStats] = useState<LeadCardStats | null>(null)
  const [pending, startTransition] = useTransition()
  const [exporting, startExport] = useTransition()

  const [filters, setFilters] = useState<LeadsFilters>({
    curatorId: '',
    status: '',
    search: '',
    sort: 'newest',
    orphanedOnly: false,
    preset: 'all',
    day: today,
    from: shiftDay(today, -6),
    to: today,
  })

  // Компактный поиск: раскрывается на фокусе или пока есть текст.
  const [searchFocused, setSearchFocused] = useState(false)

  // Realtime: id лидов, появившихся при фоновом пуллинге, — для подсветки.
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set())
  const knownIdsRef = useRef<Set<string>>(
    new Set(initialLeads.map((l) => l.id)),
  )

  // Актуальные фильтры + offset в ref (синхронизация в эффекте): фоновый
  // пуллинг и стабильные колбэки всегда видят свежие значения без
  // пересоздания интервала на каждый ввод.
  const stateRef = useRef({ ...filters, offset })
  useEffect(() => {
    stateRef.current = { ...filters, offset }
  }, [filters, offset])

  // reload стабилен (useCallback + чтение из ref) — можно передавать в
  // мемоизированные подкомпоненты.
  const reload = useCallback(
    (next: Partial<LeadsFilters & { offset: number }>) => {
      const cur = stateRef.current
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
              limit: LEADS_PAGE_SIZE,
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

  // Обновление фильтра: синхронно правит состояние (для контролируемых
  // инпутов) и перезагружает с offset = 0.
  const updateFilters = useCallback(
    (patch: Partial<LeadsFilters>) => {
      setFilters((prev) => ({ ...prev, ...patch }))
      reload(patch)
    },
    [reload],
  )

  // Поиск: моментальное состояние для инпута, перезагрузка — по debounce.
  const setSearch = useCallback((value: string) => {
    setFilters((prev) => ({ ...prev, search: value }))
  }, [])
  const debouncedSearch = useDebouncedValue(filters.search, 350)
  const searchInitRef = useRef(true)
  useEffect(() => {
    if (searchInitRef.current) {
      searchInitRef.current = false
      return
    }
    reload({ search: debouncedSearch })
  }, [debouncedSearch, reload])

  const toggleSort = useCallback(() => {
    updateFilters({
      sort: stateRef.current.sort === 'newest' ? 'oldest' : 'newest',
    })
  }, [updateFilters])

  const toggleOrphaned = useCallback(() => {
    updateFilters({ orphanedOnly: !stateRef.current.orphanedOnly })
  }, [updateFilters])

  const goToOffset = useCallback(
    (nextOffset: number) => reload({ offset: nextOffset }),
    [reload],
  )

  // Перезагрузка текущей страницы (после правки строки / передачи лида).
  const refresh = useCallback(() => {
    reload({ offset: stateRef.current.offset })
  }, [reload])

  const transfer = useCallback(
    (leadId: string, toCuratorId: string) => {
      startTransition(async () => {
        const res = await transferLeadAdminAction({
          leadCardId: leadId,
          curatorId: toCuratorId,
        })
        if (res.ok) {
          toast.success(res.message)
          refresh()
        } else {
          toast.error(res.message)
        }
      })
    },
    [refresh],
  )

  // Фоновый пуллинг каждые 5с через общий поллер (один таймер на раздел,
  // защита от наложения запросов, пропуск скрытых вкладок). Список обновляется
  // сам, новые лиды подсвечиваются. Без startTransition — никаких спиннеров.
  useSharedPoll('admin-leads', async () => {
    const f = stateRef.current
    const range = presetRange(f.preset, f.day, f.from, f.to)
    const res = await listAllLeadsAdminAction({
      curatorId: f.curatorId || null,
      status: f.status || null,
      search: f.search || null,
      sort: f.sort,
      from: range.from,
      to: range.to,
      orphanedOnly: f.orphanedOnly,
      limit: LEADS_PAGE_SIZE,
      offset: f.offset,
    })
    const arrived = res.leads
      .map((l) => l.id)
      .filter((id) => !knownIdsRef.current.has(id))
    setLeads(res.leads)
    setTotal(res.total)
    for (const id of arrived) knownIdsRef.current.add(id)
    if (arrived.length > 0) {
      setFreshIds((prev) => {
        const nextSet = new Set(prev)
        for (const id of arrived) nextSet.add(id)
        return nextSet
      })
      // Подсветка гаснет через 6 секунд.
      setTimeout(() => {
        setFreshIds((prev) => {
          const nextSet = new Set(prev)
          for (const id of arrived) nextSet.delete(id)
          return nextSet
        })
      }, 6000)
    }
  })

  /** Выгрузка текущей выборки (все страницы, без пагинации) в .xlsx. */
  const exportExcel = useCallback(() => {
    const f = stateRef.current
    const range = presetRange(f.preset, f.day, f.from, f.to)
    startExport(async () => {
      const res = await exportLeadsExcelAction({
        curatorId: f.curatorId || null,
        status: f.status || null,
        search: f.search || null,
        orphanedOnly: f.orphanedOnly,
        from: range.from,
        to: range.to,
        sort: f.sort,
      })
      if (res.ok && res.base64 && res.fileName) {
        downloadBase64Xlsx(res.base64, res.fileName)
        toast.success(`Выгружено лидов: ${res.rows}`)
      } else {
        toast.error(res.message ?? 'Не удалось выгрузить')
      }
    })
  }, [])

  const searchExpanded = searchFocused || filters.search.length > 0

  return {
    // данные
    leads,
    total,
    stats,
    offset,
    pending,
    exporting,
    freshIds,
    // фильтры
    filters,
    searchExpanded,
    // мутаторы
    updateFilters,
    setSearch,
    setSearchFocused,
    toggleSort,
    toggleOrphaned,
    goToOffset,
    refresh,
    transfer,
    exportExcel,
  }
}
