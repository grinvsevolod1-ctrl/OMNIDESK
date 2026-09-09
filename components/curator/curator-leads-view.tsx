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
  FileSpreadsheet,
  Loader2,
  User,
} from 'lucide-react'
import { toast } from 'sonner'
import { setLeadArchivedAction } from '@/app/actions/lead-cards'
import { exportMyLeadsExcelAction } from '@/app/actions/leads-export'
import { useXlsxExport } from '@/components/shared/use-xlsx-export'
import { filterLeadsByStatusAndSearch } from '@/components/shared/leads/filter-leads'
import {
  LeadsSearchInput,
  LeadsSortButton,
  LeadsStatusFilter,
  LeadsViewToggle,
} from '@/components/shared/leads/leads-toolbar-controls'
import { useLeadsViewMode } from '@/components/shared/leads/use-leads-view-mode'
import { useLeadEvents } from '@/lib/hooks/use-lead-events'
import { useSharedPoll } from '@/lib/hooks/use-shared-poll'
import { ArchiveLeadDialog } from '@/components/curator/archive-lead-dialog'
import { CuratorLeadRow } from '@/components/curator/curator-lead-row'
import { CuratorNotices } from '@/components/curator/curator-notices'
import { LeadDetailPanel } from '@/components/curator/lead-detail-panel'
import { StatusReminder } from '@/components/curator/status-reminder'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { LeadCard } from '@/lib/data/lead-cards'
import {
  DAILY_STATUS_DEADLINE_HOUR,
  isPastDailyDeadline,
  leadNeedsDailyStatus,
  leadStatusRank,
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

  // Вид: список / карточки — общий хук (localStorage, выбор переживает перелогин).
  const { view, switchView } = useLeadsViewMode(VIEW_STORAGE_KEY)

  // Фильтры — как у админа: статус, общий поиск, сортировка.
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [tab, setTab] = useState<'active' | 'archive'>('active')
  const [visible, setVisible] = useState(PAGE)

  // Пуловые лиды (ещё не взяты) НЕ считаются «требующими статуса» — они пока
  // не закреплены за куратором и не блокируют рабочее место.
  const pendingLeads = useMemo(
    () => leads.filter((l) => !l.isPool && leadNeedsDailyStatus(l)),
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

  // Как у админа: каждое открытие вкладки «Архив» подтягивает список заново
  // с сервера, а не показывает возможно устаревший кэш.
  useEffect(() => {
    if (tab === 'archive') void reloadArchive()
  }, [tab, reloadArchive])

  const refresh = useCallback(async () => {
    const { listMyCuratorLeadsAction } = await import(
      '@/app/actions/lead-cards'
    )
    const next = await listMyCuratorLeadsAction()
    setLeads(next)
    void reloadArchive()
  }, [reloadArchive])

  // Realtime: событие `lead` по SSE мгновенно перечитывает списки, а shared-poll
  // раз в 60с — страховка на случай обрыва SSE (см. use-lead-events). Один
  // EventSource пинает и список лидов, и попап уведомлений о пуле.
  useLeadEvents(['curator-leads', 'curator-notices'])
  useSharedPoll('curator-leads', refresh, 60_000)

  // Стабильные колбэки для мемоизированных строк.
  const openLead = useCallback((id: string) => setSelectedId(id), [])
  /** void-обёртка для onRefresh мемоизированных строк (inline-правки). */
  const refreshRows = useCallback(() => void refresh(), [refresh])
  // «В архив» из строки не переносит лид сразу: открывается диалог
  // с обязательным выбором причины и комментарием. Возврат из архива — сразу.
  const [archiveTarget, setArchiveTarget] = useState<LeadCard | null>(null)
  const toggleArchive = useCallback(
    (id: string, archive: boolean) => {
      if (archive) {
        setArchiveTarget(
          leads.find((l) => l.id === id) ??
            archived?.find((l) => l.id === id) ??
            null,
        )
        return
      }
      startTransition(async () => {
        const res = await setLeadArchivedAction({
          leadCardId: id,
          archived: false,
        })
        if (res.ok) {
          toast.success(res.message)
          await refresh()
        } else {
          toast.error(res.message)
        }
      })
    },
    [refresh, leads, archived],
  )

  // «Взять в работу» пуловый лид: закрепляется за этим куратором (race-safe
  // на сервере). После успеха — перечитываем список: лид уходит из пула в
  // закреплённые, у остальных кураторов он пропадёт при их обновлении.
  const claimLead = useCallback(
    (id: string) => {
      startTransition(async () => {
        const { claimPoolLeadAction } = await import(
          '@/app/actions/lead-cards'
        )
        const res = await claimPoolLeadAction({ leadCardId: id })
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
    let out = filterLeadsByStatusAndSearch(source, statusFilter, search)
    const key = (l: LeadCard) =>
      new Date(l.transferredAt ?? l.createdAt).getTime()
    // Основная сортировка активной вкладки — по статусам: NEW всегда
    // первый, дальше по ходу воронки (обучение → в работе → временно не
    // работает → не связался → отказался → игнор → кинул). Внутри одного
    // статуса — по дате (выбранное направление). В архиве — только по дате.
    out = [...out].sort((a, b) => {
      if (tab === 'active') {
        const rank = leadStatusRank(a.status) - leadStatusRank(b.status)
        if (rank !== 0) return rank
      }
      return sort === 'newest' ? key(b) - key(a) : key(a) - key(b)
    })
    // Требующие статуса — сверху внутри своего статуса в активной вкладке.
    if (tab === 'active') {
      const needs = (l: LeadCard) => leadNeedsDailyStatus(l)
      out.sort((a, b) => {
        const rank = leadStatusRank(a.status) - leadStatusRank(b.status)
        if (rank !== 0) return rank
        return Number(needs(b)) - Number(needs(a))
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-evaluates the deadline
  }, [leads, archived, tab, statusFilter, search, sort, tick])
  const shown = filtered.slice(0, visible)

  // Данные выбранного лида из уже загруженного списка — панель деталей
  // показывает их мгновенно (fallback), пока сеть догружает остальное.
  const selectedLead = useMemo(
    () =>
      selectedId
        ? (leads.find((l) => l.id === selectedId) ??
          archived?.find((l) => l.id === selectedId) ??
          null)
        : null,
    [selectedId, leads, archived],
  )

  // Компактный поиск: раскрывается на фокусе или пока есть текст.
  const searchExpanded = searchFocused || search.length > 0

  // Sidebar shell (DashboardShell) now provides page padding and width —
  // keep only the local column layout here to avoid double padding.
  return (
    <div className="relative flex w-full flex-col gap-5">
      <StatusReminder leads={leads.filter((l) => !l.isPool)} />
      <CuratorNotices onLeadsChanged={() => void refresh()} />

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

        <LeadsStatusFilter
          value={statusFilter}
          onChange={setStatusFilter}
          searchExpanded={searchExpanded}
        />

        <LeadsSearchInput
          value={search}
          onChange={setSearch}
          focused={searchFocused}
          onFocusedChange={setSearchFocused}
        />

        <LeadsSortButton
          sort={sort}
          onToggle={() => setSort((s) => (s === 'newest' ? 'oldest' : 'newest'))}
          searchExpanded={searchExpanded}
        />

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

        {/* Переключатель вида: список / карточки — общий контрол */}
        <LeadsViewToggle view={view} onSwitch={switchView} />
      </div>

      {/* Список / сетка */}
      {filtered.length === 0 ? (
        tab === 'archive' ? (
          <EmptyState
            icon={Archive}
            title="Архив пуст"
            description="Сюда попадают лиды с нерабочим статусом («Игнор», «Отказался», «Кинул») — вручную или автоматически."
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
                : 'Когда менеджер заполнит карточку и передаст лид в вашу команду, он появится здесь — возьмите его в работу.'
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
              onClaim={claimLead}
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
                onClaim={claimLead}
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

      {/* Панель всегда смонтирована (transform-only анимация) — открывается
          мгновенно с данными из строки списка, сеть догружает остальное. */}
      <LeadDetailPanel
        leadId={selectedId}
        fallbackLead={selectedLead}
        onClose={() => setSelectedId(null)}
        onUpdated={() => void refresh()}
      />

      {/* Перенос в архив: причина («Игнор»/«Отказался»/«Кинул») + комментарий */}
      <ArchiveLeadDialog
        leadCardId={archiveTarget?.id ?? null}
        leadName={archiveTarget?.fullName}
        open={archiveTarget !== null}
        onOpenChange={(o) => {
          if (!o) setArchiveTarget(null)
        }}
        onArchived={() => void refresh()}
      />


      {/* Hard lock overlay: only status updates are allowed via the detail panel */}
      {locked && !selectedId ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 border-t border-amber-500/30 bg-amber-500/95 px-4 py-3 text-center text-sm font-medium text-amber-950 shadow-lg">
          Обновите статусы всех лидов — нажмите на карточку, чтобы начать
        </div>
      ) : null}
    </div>
  )
}
