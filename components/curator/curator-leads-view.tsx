'use client'

/**
 * «Мои лиды» менеджера по кадрам — в том же визуальном стиле, что и
 * админская таблица «Все лиды»: компактные строки, фильтр по статусу,
 * общий поиск, сортировка. Отличия от админа: нет передачи другому
 * сотруднику, вместо удаления — архив. Вид (список/карточки) запоминается
 * в localStorage и восстанавливается при следующем входе.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import useSWR from 'swr'
import {
  Archive,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  FileSpreadsheet,
  LayoutGrid,
  List,
  ListFilter,
  Loader2,
  Search,
  User,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { setLeadArchivedAction } from '@/app/actions/lead-cards'
import { exportMyLeadsExcelAction } from '@/app/actions/leads-export'
import { useXlsxExport } from '@/components/shared/use-xlsx-export'
import { CuratorLeadRow } from '@/components/curator/curator-lead-row'
import { LeadDetailPanel } from '@/components/curator/lead-detail-panel'
import { StatusReminder } from '@/components/curator/status-reminder'
import { EmptyState, PageHeader } from '@/components/page-parts'
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
import type { LeadCard } from '@/lib/data/lead-cards'
import {
  DAILY_STATUS_DEADLINE_HOUR,
  isPastDailyDeadline,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  leadNeedsDailyStatus,
} from '@/lib/lead-status'
import { cn } from '@/lib/utils'

const VIEW_STORAGE_KEY = 'curator-leads-view-mode'
const PAGE = 50

export function CuratorLeadsView({
  initialLeads,
}: {
  initialLeads: LeadCard[]
}) {
  const [leads, setLeads] = useState(initialLeads)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const { exporting, runExport } = useXlsxExport()
  // Minute tick so the 10:00 MSK deadline kicks in live, without a reload.
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // Вид: список / карточки. Читаем из localStorage после маунта (SSR-безопасно)
  // и сохраняем при каждом переключении — выбор переживает перелогин.
  const [view, setView] = useState<'list' | 'grid'>('list')
  useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- гидратация: на сервере localStorage нет, восстановить выбор можно только после маунта
    if (saved === 'grid' || saved === 'list') setView(saved)
  }, [])
  const switchView = useCallback((v: 'list' | 'grid') => {
    setView(v)
    window.localStorage.setItem(VIEW_STORAGE_KEY, v)
  }, [])

  // Фильтры — как у админа: статус, общий поиск, сортировка.
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [tab, setTab] = useState<'active' | 'archive'>('active')
  const [visible, setVisible] = useState(PAGE)

  const pendingLeads = useMemo(
    () => leads.filter((l) => leadNeedsDailyStatus(l)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-evaluates the deadline
    [leads, tick],
  )
  const locked = isPastDailyDeadline() && pendingLeads.length > 0

  // Архив грузится лениво при первом открытии вкладки.
  const { data: archived, mutate: reloadArchive } = useSWR(
    tab === 'archive' ? 'curator-archived-leads' : null,
    async () => {
      const { listMyArchivedLeadsAction } = await import(
        '@/app/actions/lead-cards'
      )
      return listMyArchivedLeadsAction()
    },
    { revalidateOnFocus: false, keepPreviousData: true },
  )

  const refresh = useCallback(async () => {
    const { listMyCuratorLeadsAction } = await import(
      '@/app/actions/lead-cards'
    )
    const next = await listMyCuratorLeadsAction()
    setLeads(next)
    void reloadArchive()
  }, [reloadArchive])

  // Стабильные колбэки для мемоизированных строк.
  const openLead = useCallback((id: string) => setSelectedId(id), [])
  /** void-обёртка для onRefresh мемоизированных строк (inline-правки). */
  const refreshRows = useCallback(() => void refresh(), [refresh])
  const toggleArchive = useCallback(
    (id: string, archive: boolean) => {
      startTransition(async () => {
        const res = await setLeadArchivedAction({
          leadCardId: id,
          archived: archive,
        })
        if (res.ok) {
          toast.success(res.message)
          await refresh()
        } else {
          toast.error(res.message)
        }
      })
    },
    [refresh],
  )

  // Выгрузка текущей вкладки (активные/архив) в Excel — общий флоу
  // useXlsxExport (тот же, что у админа и менеджера).
  const exportExcel = useCallback(() => {
    runExport(() => exportMyLeadsExcelAction({ archived: tab === 'archive' }))
  }, [tab, runExport])

  // Клиентская фильтрация: лидов у одного сотрудника немного (сотни),
  // сервер не нужен — фильтр и поиск мгновенные.
  const filtered = useMemo(() => {
    const source = tab === 'archive' ? (archived ?? []) : leads
    const q = search.trim().toLowerCase()
    let out = source
    if (statusFilter === 'none') out = out.filter((l) => !l.status)
    else if (statusFilter) out = out.filter((l) => l.status === statusFilter)
    if (q) {
      out = out.filter((l) =>
        [l.fullName, l.phone, l.telegramUsername, l.city, l.vacancy]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
    }
    const key = (l: LeadCard) =>
      new Date(l.transferredAt ?? l.createdAt).getTime()
    out = [...out].sort((a, b) =>
      sort === 'newest' ? key(b) - key(a) : key(a) - key(b),
    )
    // Требующие статуса — всегда сверху в активной вкладке.
    if (tab === 'active') {
      const needs = (l: LeadCard) => leadNeedsDailyStatus(l)
      out.sort((a, b) => Number(needs(b)) - Number(needs(a)))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-evaluates the deadline
  }, [leads, archived, tab, statusFilter, search, sort, tick])
  const shown = filtered.slice(0, visible)

  // Компактный поиск: раскрывается на фокусе или пока есть текст.
  const searchExpanded = searchFocused || search.length > 0

  // Sidebar shell (DashboardShell) now provides page padding and width —
  // keep only the local column layout here to avoid double padding.
  return (
    <div className="relative flex w-full flex-col gap-5">
      <StatusReminder leads={leads} />

      <PageHeader
        title="Обзор"
        description="Лиды, переданные вам менеджерами. Статусы нужно подтверждать каждый день."
      />

      {pendingLeads.length > 0 ? (
        <div
          className={cn(
            'rounded-xl border px-4 py-3 text-sm',
            locked
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          {locked ? (
            <>
              <p className="font-medium">
                Рабочее место ограничено до обновления статусов
              </p>
              <p className="mt-1 text-xs opacity-90">
                После {DAILY_STATUS_DEADLINE_HOUR}:00 (МСК) необходимо
                подтвердить статус каждого лида с комментарием. Осталось:{' '}
                {pendingLeads.length}. Уведомления будут повторяться каждые 20
                минут.
              </p>
            </>
          ) : (
            <p>
              Есть лиды без статуса — лучше заполнить до{' '}
              {DAILY_STATUS_DEADLINE_HOUR}:00 МСК ({pendingLeads.length}).
            </p>
          )}
        </div>
      ) : null}

      {/* Панель фильтров — в стиле админской таблицы */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Вкладки Активные / Архив — h-9, как все контролы строки */}
        <div className="flex h-9 items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
          <button
            type="button"
            onClick={() => {
              setTab('active')
              setVisible(PAGE)
            }}
            className={cn(
              'flex h-7 items-center rounded-md px-3 text-sm transition-colors',
              tab === 'active'
                ? 'bg-background font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Активные ({leads.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('archive')
              setVisible(PAGE)
            }}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-3 text-sm transition-colors',
              tab === 'archive'
                ? 'bg-background font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Archive className="size-4 shrink-0" />
            Архив
          </button>
        </div>

        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter((v as string) ?? '')}
        >
          <SelectTrigger
            className={cn(
              'h-9 gap-2 font-medium transition-all duration-300',
              searchExpanded && 'max-w-40',
            )}
            aria-label="Фильтр по статусу"
          >
            <ListFilter className="size-4 shrink-0 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-auto min-w-44">
            <SelectItem value="">Все статусы (по умолчанию)</SelectItem>
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

        {/* Компактный поиск: узкий по умолчанию, плавно расширяется на фокус */}
        <div
          className={cn(
            'relative min-w-0 transition-all duration-300 ease-out',
            searchExpanded ? 'flex-1 basis-64' : 'flex-none basis-44',
          )}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder={searchExpanded ? 'ФИО, телефон, @username, город…' : 'Поиск'}
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
              <X className="size-4" />
            </button>
          ) : null}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => setSort((s) => (s === 'newest' ? 'oldest' : 'newest'))}
          aria-label="Переключить сортировку"
          title={sort === 'newest' ? 'Сначала новые' : 'Сначала старые'}
        >
          {sort === 'newest' ? (
            <ArrowDownWideNarrow className="size-4 shrink-0" />
          ) : (
            <ArrowUpNarrowWide className="size-4 shrink-0" />
          )}
          {!searchExpanded ? (sort === 'newest' ? 'Новые' : 'Старые') : null}
        </Button>

        {/* Выгрузка текущей вкладки в Excel — как у админа */}
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          disabled={exporting}
          onClick={exportExcel}
          aria-label="Выгрузить в Excel"
          title="Выгрузить текущую вкладку в Excel"
        >
          {exporting ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : (
            <FileSpreadsheet className="size-4 shrink-0" />
          )}
          {!searchExpanded ? 'Excel' : null}
        </Button>

        {/* Переключатель вида: список / карточки — h-9, как все контролы */}
        <div className="flex h-9 items-center rounded-lg border border-border p-1">
          <button
            type="button"
            onClick={() => switchView('list')}
            aria-label="Вид: список"
            aria-pressed={view === 'list'}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              view === 'list'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <List className="size-4 shrink-0" />
          </button>
          <button
            type="button"
            onClick={() => switchView('grid')}
            aria-label="Вид: карточки"
            aria-pressed={view === 'grid'}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              view === 'grid'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <LayoutGrid className="size-4 shrink-0" />
          </button>
        </div>
      </div>

      {/* Список / сетка */}
      {filtered.length === 0 ? (
        tab === 'archive' ? (
          <EmptyState
            icon={Archive}
            title="Архив пуст"
            description="Сюда попадают лиды с финальным статусом («Отказался», «Кинул») — вручную или автоматически."
          />
        ) : (
          <EmptyState
            icon={User}
            title={
              search || statusFilter ? 'Ничего не найдено' : 'Пока нет лидов'
            }
            description={
              search || statusFilter
                ? 'Попробуйте изменить фильтры или запрос поиска.'
                : 'Когда менеджер заполнит карточку и передаст лид по вашему городу, он появится здесь.'
            }
          />
        )
      ) : view === 'grid' ? (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((lead) => (
            <CuratorLeadRow
              key={lead.id}
              lead={lead}
              view="grid"
              isArchived={tab === 'archive'}
              pending={pending}
              onOpen={openLead}
              onToggleArchive={toggleArchive}
              onRefresh={refreshRows}
            />
          ))}
        </ul>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {shown.map((lead) => (
              <CuratorLeadRow
                key={lead.id}
                lead={lead}
                view="list"
                isArchived={tab === 'archive'}
                pending={pending}
                onOpen={openLead}
                onToggleArchive={toggleArchive}
                onRefresh={refreshRows}
              />
            ))}
          </ul>
        </Card>
      )}

      {filtered.length > visible ? (
        <button
          type="button"
          onClick={() => setVisible((v) => v + PAGE)}
          className="rounded-xl border border-border py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/40"
        >
          Показать ещё ({filtered.length - visible})
        </button>
      ) : null}

      {selectedId ? (
        <LeadDetailPanel
          leadId={selectedId}
          onClose={() => setSelectedId(null)}
          onUpdated={() => void refresh()}
        />
      ) : null}

      {/* Hard lock overlay: only status updates are allowed via the detail panel */}
      {locked && !selectedId ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 border-t border-amber-500/30 bg-amber-500/95 px-4 py-3 text-center text-sm font-medium text-amber-950 shadow-lg">
          Обновите статусы всех лидов — нажмите на карточку, чтобы начать
        </div>
      ) : null}
    </div>
  )
}
