'use client'

import { memo, useCallback, useMemo, useState } from 'react'
import { AdminLeadRow } from '@/components/admin/leads/admin-lead-row'
import { LeadsFilterBar } from '@/components/admin/leads/leads-filter-bar'
import { LeadsPagination } from '@/components/admin/leads/leads-pagination'
import { LeadsPeriodStats } from '@/components/admin/leads/leads-period-stats'
import type { PeriodPreset } from '@/components/admin/leads/period-range'
import {
  LEADS_PAGE_SIZE,
  useLeadsData,
} from '@/components/admin/leads/use-leads-data'
import { PeriodFilter } from '@/components/shared/period-filter'
import { LeadDetailPanel } from '@/components/curator/lead-detail-panel'
import { Card } from '@/components/ui/card'
import type { CuratorWithLoad, LeadCard } from '@/lib/data/lead-cards'
import { mskDayKey } from '@/lib/time'
import { cn } from '@/lib/utils'

/**
 * memo-обёртка панели: контейнер перерисовывается на каждый пуллинг списка,
 * а открытая карточка (тяжёлое дерево: комментарии, история, вложения) должна
 * рендериться заново только когда реально изменились её пропсы. Вместе с
 * mergeLeads (identity-preserving слияние в use-leads-data) это убирает
 * лаги открытой карточки.
 */
const MemoLeadDetailPanel = memo(LeadDetailPanel)

/** Пресеты периода списка «Все лиды»: со «Всё время» и одиночным «День». */
const LEADS_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: 'all', label: 'Всё время' },
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: 'day', label: 'День' },
  { key: 'range', label: 'Период' },
]

/**
 * Admin overview of ALL transferred leads. Презентационный контейнер: вся
 * логика (фильтры, пуллинг, загрузка, экспорт, передача) живёт в хуке
 * useLeadsData; здесь — только раскладка по подкомпонентам: фильтр периода
 * (LeadsPeriodFilter), панель фильтров (LeadsFilterBar), строки таблицы
 * (AdminLeadRow), статистика (LeadsPeriodStats), пагинация (LeadsPagination)
 * и полная карточка лида (LeadDetailPanel).
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

  const {
    leads,
    total,
    stats,
    offset,
    pending,
    exporting,
    freshIds,
    filters,
    searchExpanded,
    updateFilters,
    setSearch,
    setSearchFocused,
    toggleSort,
    toggleOrphaned,
    toggleArchived,
    goToOffset,
    refresh,
    transfer,
    exportExcel,
  } = useLeadsData({ initialLeads, initialTotal, today })

  // Полная карточка лида: клик по свободному месту строки — как у
  // менеджера по кадрам (комментарии, история, вложения, статус).
  const [openedLeadId, setOpenedLeadId] = useState<string | null>(null)
  const openLead = useCallback((id: string) => setOpenedLeadId(id), [])
  const closeLead = useCallback(() => setOpenedLeadId(null), [])
  // Благодаря mergeLeads объект лида стабилен между пуллингами —
  // find возвращает ту же ссылку, и memo-панель не перерисовывается.
  const openedLead = useMemo(
    () =>
      openedLeadId ? (leads.find((l) => l.id === openedLeadId) ?? null) : null,
    [openedLeadId, leads],
  )

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {filters.archivedOnly ? 'Архив лидов' : 'Все лиды'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {filters.archivedOnly
              ? `Лиды с нерабочим статусом, ушедшие из активного рабочего места. Всего: ${total}. Откройте карточку, чтобы вернуть лид из архива.`
              : `Все переданные лиды по всем менеджерам по кадрам. Всего: ${total}.`}
          </p>
        </div>
        {orphanedCount > 0 ? (
          <button
            type="button"
            onClick={toggleOrphaned}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              filters.orphanedOnly
                ? 'border-transparent bg-destructive/15 text-destructive'
                : 'border-destructive/40 text-destructive hover:bg-destructive/10',
            )}
          >
            Без менеджера по кадрам: {orphanedCount}
          </button>
        ) : null}
      </div>

      {/* Пресеты периода: статистика по датам (сегодня / период / день) */}
      <PeriodFilter
        presets={LEADS_PRESETS}
        preset={filters.preset}
        day={filters.day}
        from={filters.from}
        to={filters.to}
        today={today}
        onPreset={(p) => updateFilters({ preset: p })}
        onDay={(v) => updateFilters({ day: v })}
        onFrom={(v) => updateFilters({ from: v })}
        onTo={(v) => updateFilters({ to: v })}
      />

      {/* Статистика за выбранный период */}
      {stats && filters.preset !== 'all' ? (
        <LeadsPeriodStats stats={stats} today={today} />
      ) : null}

      <LeadsFilterBar
        curatorId={filters.curatorId}
        status={filters.status}
        search={filters.search}
        sort={filters.sort}
        orphanedOnly={filters.orphanedOnly}
        archivedOnly={filters.archivedOnly}
        exporting={exporting}
        searchExpanded={searchExpanded}
        curators={curators}
        onCuratorChange={(v) => updateFilters({ curatorId: v })}
        onStatusChange={(v) => updateFilters({ status: v })}
        onSearchChange={setSearch}
        onSearchFocus={() => setSearchFocused(true)}
        onSearchBlur={() => setSearchFocused(false)}
        onToggleSort={toggleSort}
        onToggleArchived={toggleArchived}
        onExport={exportExcel}
        onTrashChanged={refresh}
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
                onRefresh={refresh}
                onTransfer={transfer}
                onOpen={openLead}
              />
            ))}
          </ul>
        )}
      </Card>

      {total > LEADS_PAGE_SIZE ? (
        <LeadsPagination
          total={total}
          offset={offset}
          pageSize={LEADS_PAGE_SIZE}
          pending={pending}
          onPage={goToOffset}
        />
      ) : null}

      {/* Полная карточка лида — та же панель, что у менеджера по кадрам,
          в админ-режиме (статус через админский action, виден владелец).
          Всегда смонтирована (transform-only анимация) и открывается
          мгновенно с данными из строки списка. */}
      <MemoLeadDetailPanel
        leadId={openedLeadId}
        fallbackLead={openedLead}
        variant="admin"
        onClose={closeLead}
        onUpdated={refresh}
      />
    </section>
  )
}
