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
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Briefcase,
  Eye,
  LayoutGrid,
  List,
  ListFilter,
  Search,
  User,
  Users,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  listGroupArchivedLeadsAction,
  listGroupLeadsAction,
} from '@/app/actions/heads'
import { LeadDetailPanel } from '@/components/curator/lead-detail-panel'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
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
import type { HeadCurator, HeadManager } from '@/lib/data/heads'
import type { LeadCard } from '@/lib/data/lead-cards'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
} from '@/lib/lead-status'
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
  const date =
    isArchived && lead.archivedAt
      ? formatMskDateTime(lead.archivedAt)
      : lead.transferredAt
        ? formatMskDateTime(lead.transferredAt)
        : '—'

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
        <span className="mt-auto text-xs tabular-nums text-muted-foreground">
          {date}
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
  const { data: archived } = useSWR(
    tab === 'archive' ? 'head-group-archived-leads' : null,
    () => listGroupArchivedLeadsAction(),
    { revalidateOnFocus: false },
  )

  // Вид: список / карточки — как у куратора, выбор переживает перелогин.
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

  const source = tab === 'archive' ? (archived ?? []) : leads

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = source
    if (memberFilter) {
      const [kind, id] = memberFilter.split(':')
      out =
        kind === 'curator'
          ? out.filter((l) => l.curatorId === id)
          : out.filter((l) => l.managerId === id)
    }
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
      new Date(
        tab === 'archive'
          ? (l.archivedAt ?? l.transferredAt ?? l.createdAt)
          : (l.transferredAt ?? l.createdAt),
      ).getTime()
    return [...out].sort((a, b) =>
      sort === 'newest' ? key(b) - key(a) : key(a) - key(b),
    )
  }, [source, tab, memberFilter, statusFilter, search, sort])
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
            ? 'Лиды ваших куратор��в и менеджеров. Вы можете править карточки, статусы и передавать лидов между кураторами группы.'
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
            placeholder={
              searchExpanded ? 'ФИО, телефон, @username, город…' : 'Поиск'
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

        {/* Переключатель вида: список / карточки — как у куратора */}
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
