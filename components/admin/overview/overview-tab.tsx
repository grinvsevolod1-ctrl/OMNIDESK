'use client'

import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import useSWR from 'swr'
import { getSourcesOverviewAction } from '@/app/actions/sources'
import { ManageGroupsDialog } from '@/components/admin/dashboard/source-groups/manage-groups-dialog'
import { CreateSourceDialog } from '@/components/admin/sources/create-source-dialog'
import { useMutateSources } from '@/components/admin/sources/use-mutate-sources'
import type { ChannelOption } from '@/components/admin/dashboard/source-groups/shared'
import { Button } from '@/components/ui/button'
import type { SourceGroup } from '@/lib/data'
import type { SourcesOverview } from '@/lib/data/sources'
import { AiBar } from './ai-bar'
import { PeriodPicker, resolvePeriod } from './period-picker'
import { SourceDetail, UnassignedDetail } from './source-detail'
import { SourceGrid, UNASSIGNED_ID } from './source-grid'
import { useOverviewPrefs } from './use-overview-prefs'

/**
 * Вкладка «Обзор»: источники как единая сущность проекта.
 * Сверху — период (пресеты + произвольные даты), сетка/список источников;
 * клик раскрывает панель деталей (трафик + воронка лидов + деньги).
 * Вид и период запоминаются между заходами.
 */
export function OverviewTab({
  initialOverview,
  groups,
  channels,
}: {
  initialOverview: SourcesOverview
  groups: SourceGroup[]
  channels: ChannelOption[]
}) {
  const [prefs, updatePrefs] = useOverviewPrefs()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const resolved = useMemo(
    () => resolvePeriod(prefs.preset, prefs.customFrom, prefs.customTo),
    [prefs.preset, prefs.customFrom, prefs.customTo],
  )
  const range = useMemo(
    () => ({
      fromISO: resolved.from.toISOString(),
      toISO: resolved.to.toISOString(),
    }),
    [resolved],
  )

  const { data: payload = { overview: initialOverview, prev: undefined } } =
    useSWR(
      ['sources-overview', range.fromISO, range.toISO],
      async () => {
        const tz = new Date().getTimezoneOffset()
        const res = await getSourcesOverviewAction(
          range.fromISO,
          range.toISO,
          tz,
        )
        if (!res.ok || !res.data) throw new Error(res.message)
        return { overview: res.data, prev: res.prev }
      },
      {
        keepPreviousData: true,
        // Возврат на вкладку подтягивает свежие данные (сервер держит
        // 60-сек кэш агрегатов, так что это дёшево).
        fallbackData: { overview: initialOverview, prev: undefined },
      },
    )
  const overview = payload.overview
  const prev = payload.prev

  const unassigned = overview.unassigned
  const mutateSources = useMutateSources()

  const fallbackPeriod = useMemo(
    () => ({
      fromISO: range.fromISO,
      toISO: range.toISO,
      label: resolved.label.toLowerCase(),
    }),
    [range, resolved.label],
  )

  return (
    <div className="flex flex-col gap-4">
      {/* ИИ-строка: вопросы своими словами, ответы структурными виджетами */}
      <AiBar
        sources={overview.items.map((s) => ({ id: s.id, name: s.name }))}
        fallbackPeriod={fallbackPeriod}
        onOpenSource={(id) => setActiveId(id)}
        onDataChanged={() => void mutateSources()}
      />

      {/* Шапка: период + управление источниками */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PeriodPicker
          preset={prefs.preset}
          customFrom={prefs.customFrom}
          customTo={prefs.customTo}
          resolved={resolved}
          onChange={(patch) => updatePrefs(patch)}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" /> Новый источник
          </Button>
          <ManageGroupsDialog groups={groups} channels={channels} />
        </div>
      </div>

      {/* Диалог сам сбрасывает source-кэши после создания */}
      <CreateSourceDialog open={createOpen} onOpenChange={setCreateOpen} />

      {/* Сетка источников */}
      {overview.items.length === 0 && !unassigned ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="text-sm font-medium">Пока нет ни каналов, ни источников</p>
          <p className="max-w-sm text-sm text-muted-foreground text-pretty">
            Подключите каналы во вкладке «Каналы» — они сразу появятся здесь, даже
            без настройки источников.
          </p>
        </div>
      ) : (
        <SourceGrid
          overview={overview}
          activeId={activeId}
          onSelect={(id) => setActiveId((cur) => (cur === id ? null : id))}
          prev={prev}
          view={prefs.view}
          onViewChange={(view) => updatePrefs({ view })}
        />
      )}

      {/* Панель деталей выбранного источника */}
      {activeId === UNASSIGNED_ID && unassigned ? (
        <UnassignedDetail
          channels={unassigned.channels}
          onClose={() => setActiveId(null)}
        />
      ) : activeId ? (
        <SourceDetail
          sourceId={activeId}
          fromISO={range.fromISO}
          toISO={range.toISO}
          onClose={() => setActiveId(null)}
        />
      ) : null}
    </div>
  )
}
