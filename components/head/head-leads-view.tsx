'use client'

/**
 * Панель руководителя (/head): активные лиды всей его группы — кураторов
 * (менеджеров по кадрам) и менеджеров продаж — в том же визуальном стиле, что
 * и «Мои лиды» куратора. Отличия: фильтр по конкретному подчинённому (куратор
 * ЛИБО менеджер), колонка «Исполнитель», и режим прав: canEdit=false — только
 * просмотр (детальная панель без форм), canEdit=true — правка полей, статусов,
 * комментарии и передача внутри группы (передача — только между кураторами).
 */

import { useCallback, useMemo, useState } from 'react'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Briefcase,
  Eye,
  ListFilter,
  Search,
  User,
  Users,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { listGroupLeadsAction } from '@/app/actions/heads'
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = leads
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
      new Date(l.transferredAt ?? l.createdAt).getTime()
    return [...out].sort((a, b) =>
      sort === 'newest' ? key(b) - key(a) : key(a) - key(b),
    )
  }, [leads, memberFilter, statusFilter, search, sort])
  const shown = filtered.slice(0, visible)

  const selectedLead = useMemo(
    () => (selectedId ? (leads.find((l) => l.id === selectedId) ?? null) : null),
    [selectedId, leads],
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
      </div>

      {/* Список */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={User}
          title={
            search || statusFilter || memberFilter
              ? 'Ничего не найдено'
              : 'Пока нет лидов'
          }
          description={
            search || statusFilter || memberFilter
              ? 'Попробуйте изменить фильтры или запрос поиска.'
              : 'Когда у ваших сотрудников появятся лиды, они отобразятся здесь.'
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {shown.map((lead) => (
              <li key={lead.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(lead.id)}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
                >
                  <span className="min-w-32 flex-1 truncate text-sm font-medium">
                    {lead.fullName || 'Без имени'}
                  </span>
                  <span className="hidden w-28 truncate text-xs text-muted-foreground sm:block">
                    {lead.city || '—'}
                  </span>
                  <span className="hidden w-40 min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground md:flex">
                    {lead.curatorId ? (
                      <>
                        <Users className="size-3 shrink-0" />
                        {lead.curatorName ?? '—'}
                      </>
                    ) : (
                      <>
                        <Briefcase className="size-3 shrink-0" />
                        {lead.managerName ?? '—'}
                      </>
                    )}
                  </span>
                  <span className="hidden w-36 text-xs tabular-nums text-muted-foreground lg:block">
                    {lead.transferredAt
                      ? formatMskDateTime(lead.transferredAt)
                      : '—'}
                  </span>
                  <LeadStatusBadge
                    status={lead.status}
                    previousStatus={lead.previousStatus}
                  />
                </button>
              </li>
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
