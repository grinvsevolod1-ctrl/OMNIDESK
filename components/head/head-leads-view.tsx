'use client'

/**
 * Панель руководителя (/head): активные лиды всей его группы — кураторов
 * (менеджеров по кадрам) и менеджеров продаж — в том же визуальном стиле, что
 * и «Мои лиды» куратора. Отличия: фильтр по конкретному подчинённому (куратор
 * ЛИБО менеджер), колонка «Исполнитель», и режим прав: canEdit=false — только
 * просмотр (детальная панель без форм), canEdit=true — правка полей, статусов,
 * комментарии и передача внутри группы (передача — только между кураторами).
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  Archive,
  Briefcase,
  Eye,
  User,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  listGroupArchivedLeadsAction,
  listGroupLeadsAction,
} from '@/app/actions/heads'
import { LeadDetailPanel } from '@/components/curator/lead-detail-panel'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { filterLeadsByStatusAndSearch } from '@/components/shared/leads/filter-leads'
import {
  LeadsSearchInput,
  LeadsSortButton,
  LeadsStatusFilter,
  LeadsViewToggle,
} from '@/components/shared/leads/leads-toolbar-controls'
import { useLeadsViewMode } from '@/components/shared/leads/use-leads-view-mode'
import { Card } from '@/components/ui/card'
import type { HeadCurator, HeadManager } from '@/lib/data/heads'
import type { LeadCard } from '@/lib/data/lead-cards'
import { formatMskDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

const PAGE = 50
const VIEW_STORAGE_KEY = 'head-leads-view-mode'

/**
 * Строка/карточка лида в панели руководителя. Список — CSS grid с фиксированными
 * колонками (имя · город · исполнитель · дата · статус), чтобы колонки были
 * выровнены во всех строках; карточка — как у куратора. Мемоизирована.
 */
const HeadLeadRow = memo(function HeadLeadRow({
  lead,
  view,
  isArchived,
  onOpen,
}: {
  lead: LeadCard
  view: 'list' | 'grid'
  /** Строка во вкладке «Архив»: показываем дату архивации, а не передачи. */
  isArchived: boolean
  onOpen: (id: string) => void
}) {
  const executor = lead.curatorId ? (
    <>
      <Users className="size-3 shrink-0" />
      <span className="truncate">{lead.curatorName ?? '—'}</span>
    </>
  ) : (
    <>
      <Briefcase className="size-3 shrink-0" />
      <span className="truncate">{lead.managerName ?? '—'}</span>
    </>
  )
  const dateValue =
    isArchived && lead.archivedAt
      ? lead.archivedAt
      : lead.transferredAt
        ? lead.transferredAt
        : null
  const dateLabel = isArchived ? 'В архиве' : 'Передан'
  const date = dateValue ? formatMskDateTime(dateValue) : '—'

  if (view === 'grid') {
    return (
      <li
        className={cn(
          'group flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-muted/30',
          '[content-visibility:auto] [contain-intrinsic-size:auto_8rem]',
        )}
        onClick={() => onOpen(lead.id)}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {lead.fullName || 'Без имени'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {[lead.vacancy, lead.phone].filter(Boolean).join(' · ') || '—'}
            </p>
          </div>
            <LeadStatusBadge
              status={lead.status}
              previousStatus={lead.previousStatus}
              at={lead.statusConfirmedAt}
            />
          </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {executor}
          {lead.city ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{lead.city}</span>
            </>
          ) : null}
        </div>
        <span className="mt-auto inline-flex items-center gap-1 text-[11px] leading-none text-muted-foreground">
          {dateValue ? (
            <>
              <span className="opacity-70">{dateLabel}</span>
              <time dateTime={dateValue} className="tabular-nums">
                {date}
              </time>
            </>
          ) : (
            <span className="tabular-nums">—</span>
          )}
        </span>
      </li>
    )
  }

  return (
    <li className="[content-visibility:auto] [contain-intrinsic-size:auto_3.5rem]">
      <button
        type="button"
        onClick={() => onOpen(lead.id)}
        className={cn(
          'grid w-full grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-x-4 px-4 py-2.5 text-left transition-colors hover:bg-muted/40',
          'sm:grid-cols-[minmax(0,1fr)_7rem_7.5rem]',
          'md:grid-cols-[minmax(0,1fr)_7rem_minmax(0,10rem)_7.5rem]',
          'lg:grid-cols-[minmax(0,1fr)_7rem_minmax(0,10rem)_8.5rem_7.5rem]',
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {lead.fullName || 'Без имени'}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {[lead.vacancy, lead.phone].filter(Boolean).join(' · ') || '—'}
          </span>
        </span>
        <span className="hidden truncate text-xs text-muted-foreground sm:block">
          {lead.city || '—'}
        </span>
        <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground md:flex">
          {executor}
        </span>
        <span className="hidden text-xs tabular-nums text-muted-foreground lg:block">
          {date}
        </span>
        <span className="flex justify-end">
            <LeadStatusBadge
              status={lead.status}
              previousStatus={lead.previousStatus}
              at={lead.statusConfirmedAt}
            />
          </span>
      </button>
    </li>
  )
})

/** Ряд чипов-фильтров по подчинённым одного вида (кураторы или менеджеры). */
function MemberFilterRow({
  label,
  icon: Icon,
  members,
  kind,
  activeFilter,
  onToggle,
}: {
  label: string
  icon: LucideIcon
  members: { id: string; name: string; city?: string | null; activeLeads: number }[]
  kind: 'curator' | 'manager'
  activeFilter: string
  onToggle: (next: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-full text-xs font-medium uppercase tracking-wide text-muted-foreground sm:w-auto">
        {label}
      </span>
      {members.map((m) => {
        const value = `${kind}:${m.id}`
        const active = activeFilter === value
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onToggle(active ? '' : value)}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors',
              active
                ? 'border-primary bg-primary/10 font-medium'
                : 'border-border bg-muted/30 text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {m.name}
            {m.city ? (
              <span className="text-xs opacity-70">({m.city})</span>
            ) : null}
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">
              {m.activeLeads}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function HeadLeadsView({
  initialLeads,
  curators,
  managers,
  canEdit,
}: {
  initialLeads: LeadCard[]
  curators: HeadCurator[]
  managers: HeadManager[]
  canEdit: boolean
}) {
  const [leads, setLeads] = useState(initialLeads)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Вкладка «Активные» / «Архив». Архив грузится лениво при первом открытии.
  const [tab, setTab] = useState<'active' | 'archive'>('active')
  const { data: archived, mutate: reloadArchive } = useSWR(
    tab === 'archive' ? 'head-group-archived-leads' : null,
    () => listGroupArchivedLeadsAction(),
    { revalidateOnFocus: false },
  )

  // Как у админа: каждое открытие вкладки «Архив» подтягивает список заново
  // с сервера, а не показывает возможно устаревший кэш.
  useEffect(() => {
    if (tab === 'archive') void reloadArchive()
  }, [tab, reloadArchive])

  // Вид: список / карточки — как у куратора, выбор переживает перелогин.
  const { view, switchView } = useLeadsViewMode(VIEW_STORAGE_KEY)

  // Фильтр по подчинённому: строка вида `curator:<id>` или `manager:<id>`,
  // чтобы различать людей из разных таблиц (id уникальны, но семантика разная).
  const [memberFilter, setMemberFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [visible, setVisible] = useState(PAGE)

  const refresh = useCallback(async () => {
    setLeads(await listGroupLeadsAction())
  }, [])

  // Стабильный колбэк для мемоизированных строк.
  const openLead = useCallback((id: string) => setSelectedId(id), [])

  const filtered = useMemo(() => {
    const source = tab === 'archive' ? (archived ?? []) : leads
    let out = source
    if (memberFilter) {
      const [kind, id] = memberFilter.split(':')
      out =
        kind === 'curator'
          ? out.filter((l) => l.curatorId === id)
          : out.filter((l) => l.managerId === id)
    }
    out = filterLeadsByStatusAndSearch(out, statusFilter, search)
    const key = (l: LeadCard) =>
      new Date(
        tab === 'archive'
          ? (l.archivedAt ?? l.transferredAt ?? l.createdAt)
          : (l.transferredAt ?? l.createdAt),
      ).getTime()
    return [...out].sort((a, b) =>
      sort === 'newest' ? key(b) - key(a) : key(a) - key(b),
    )
  }, [leads, archived, tab, memberFilter, statusFilter, search, sort])
  const shown = filtered.slice(0, visible)

  const selectedLead = useMemo(
    () =>
      selectedId
        ? (leads.find((l) => l.id === selectedId) ??
          archived?.find((l) => l.id === selectedId) ??
          null)
        : null,
    [selectedId, leads, archived],
  )

  const searchExpanded = searchFocused || search.length > 0

  return (
    <div className="relative flex w-full flex-col gap-5">
      <PageHeader
        title="Обзор группы"
        description={
          canEdit
            ? 'Лиды ваших кураторов и менеджеров. Вы можете править карточки, статусы и передавать лидов между кураторами группы.'
            : 'Лиды ваших кураторов и менеджеров. Режим «только просмотр» — правки недоступны.'
        }
      />

      {!canEdit ? (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Eye className="size-4 shrink-0" />
          <p>
            У вас право «только просмотр». За правом редактирования обратитесь
            к администратору.
          </p>
        </div>
      ) : null}

      <div className="flex w-full max-w-xs items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
        <button
          type="button"
          onClick={() => setTab('active')}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            tab === 'active'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Активные
        </button>
        <button
          type="button"
          onClick={() => setTab('archive')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            tab === 'archive'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Archive className="size-3.5" />
          Архив
        </button>
      </div>

      {/* Сводка по подчинённым: кураторы и менеджеры отдельными рядами,
          клик по чипу фильтрует список по этому сотруднику. */}
      {curators.length === 0 && managers.length === 0 ? (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          За вами пока не закреплены сотрудники — обратитесь к администратору.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {curators.length > 0 ? (
            <MemberFilterRow
              label="Менеджеры по кадрам"
              icon={Users}
              members={curators}
              kind="curator"
              activeFilter={memberFilter}
              onToggle={setMemberFilter}
            />
          ) : null}
          {managers.length > 0 ? (
            <MemberFilterRow
              label="Менеджеры продаж"
              icon={Briefcase}
              members={managers}
              kind="manager"
              activeFilter={memberFilter}
              onToggle={setMemberFilter}
            />
          ) : null}
        </div>
      )}

      {/* Панель фильтров */}
      <div className="flex flex-wrap items-center gap-2">
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
        <LeadsViewToggle view={view} onSwitch={switchView} />
      </div>

      {/* Список */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={User}
          title={
            search || statusFilter || memberFilter
              ? 'Ничего не найдено'
              : tab === 'archive'
                ? 'Архив пуст'
                : 'Пока нет лидов'
          }
          description={
            search || statusFilter || memberFilter
              ? 'Попробуйте изменить фильтры или запрос поиска.'
              : tab === 'archive'
                ? 'Архивированные лиды ваших сотрудников появятся здесь.'
                : 'Когда у ваших сотрудников появятся лиды, они отобразятся здесь.'
          }
        />
      ) : view === 'grid' ? (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((lead) => (
            <HeadLeadRow
              key={lead.id}
              lead={lead}
              view="grid"
              isArchived={tab === 'archive'}
              onOpen={openLead}
            />
          ))}
        </ul>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {shown.map((lead) => (
              <HeadLeadRow
                key={lead.id}
                lead={lead}
                view="list"
                isArchived={tab === 'archive'}
                onOpen={openLead}
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

      <LeadDetailPanel
        leadId={selectedId}
        fallbackLead={selectedLead}
        onClose={() => setSelectedId(null)}
        onUpdated={() => void refresh()}
        variant="head"
        headCanEdit={canEdit}
      />
    </div>
  )
}
