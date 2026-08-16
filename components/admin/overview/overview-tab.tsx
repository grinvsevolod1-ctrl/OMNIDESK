'use client'

import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import useSWR, { useSWRConfig } from 'swr'
import { getSourcesOverviewAction } from '@/app/actions/sources'
import { ManageGroupsDialog } from '@/components/admin/dashboard/source-groups/manage-groups-dialog'
import { CreateSourceDialog } from '@/components/admin/sources/create-source-dialog'
import {
  rangeFromPreset,
  type ChannelOption,
  type Preset,
} from '@/components/admin/dashboard/source-groups/shared'
import { Button } from '@/components/ui/button'
import type { SourceGroup } from '@/lib/data'
import type { SourcesOverview } from '@/lib/data/sources'
import { cn } from '@/lib/utils'
import { AiBar } from './ai-bar'
import { SourceDetail, UnassignedDetail } from './source-detail'
import { SourceGrid, UNASSIGNED_ID } from './source-grid'

const PRESETS: { id: Exclude<Preset, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Сегодня' },
  { id: '7d', label: '7 дней' },
  { id: '30d', label: '30 дней' },
]

/**
 * Вкладка «Обзор»: источники как единая сущность проекта.
 * Сверху — период, сетка карточек источников; клик по карточке раскрывает
 * панель деталей (трафик + воронка лидов + деньги).
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
  const [preset, setPreset] = useState<Exclude<Preset, 'custom'>>('7d')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const range = useMemo(() => {
    const { from, to } = rangeFromPreset(preset)
    return { fromISO: from.toISOString(), toISO: to.toISOString() }
  }, [preset])

  const { data: overview = initialOverview } = useSWR(
    ['sources-overview', range.fromISO, range.toISO],
    async () => {
      const tz = new Date().getTimezoneOffset()
      const res = await getSourcesOverviewAction(
        range.fromISO,
        range.toISO,
        tz,
      )
      if (!res.ok || !res.data) throw new Error(res.message)
      return res.data
    },
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      fallbackData: initialOverview,
    },
  )

  const unassigned = overview.unassigned
  const { mutate } = useSWRConfig()

  const fallbackPeriod = useMemo(
    () => ({
      fromISO: range.fromISO,
      toISO: range.toISO,
      label:
        PRESETS.find((p) => p.id === preset)?.label.toLowerCase() ?? 'за период',
    }),
    [range, preset],
  )

  return (
    <div className="flex flex-col gap-4">
      {/* ИИ-строка: вопросы своими словами, ответы структурными виджетами */}
      <AiBar
        sources={overview.items.map((s) => ({ id: s.id, name: s.name }))}
        fallbackPeriod={fallbackPeriod}
        onOpenSource={(id) => setActiveId(id)}
        onDataChanged={() => {
          void mutate(
            (key) => Array.isArray(key) && key[0] === 'sources-overview',
          )
        }}
      />

      {/* Шапка: период + управление источниками */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Период"
          className="flex items-center rounded-lg border border-border p-0.5"
        >
          {PRESETS.map((p) => (
            <Button
              key={p.id}
              variant="ghost"
              size="sm"
              onClick={() => setPreset(p.id)}
              className={cn(
                'h-7 rounded-md px-3 text-xs',
                preset === p.id
                  ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground'
                  : 'text-muted-foreground',
              )}
              aria-pressed={preset === p.id}
            >
              {p.label}
            </Button>
          ))}
        </div>
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

      <CreateSourceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          void mutate(
            (key) => Array.isArray(key) && key[0] === 'sources-overview',
          )
        }}
      />

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
