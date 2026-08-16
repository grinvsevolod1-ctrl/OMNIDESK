'use client'

/**
 * Source-groups overview — container. Owns the group/period selection state
 * and the SWR report fetch; presentation lives in ./source-groups/
 * (group-report.tsx, manage-groups-dialog.tsx, shared.ts), following the
 * container+parts convention used across the admin UI.
 */

import { useState } from 'react'
import useSWR from 'swr'
import { Layers, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getGroupAnalyticsAction } from '@/app/actions/groups'
import { PageHeader } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SourceGroup } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Report } from './source-groups/group-report'
import { ManageGroupsDialog } from './source-groups/manage-groups-dialog'
import {
  rangeFromPreset,
  startOfDay,
  ymd,
  type ChannelOption,
  type Preset,
} from './source-groups/shared'

export function SourceGroupsOverview({
  groups,
  channels,
  initialGroupId,
}: {
  groups: SourceGroup[]
  channels: ChannelOption[]
  initialGroupId: string | null
}) {
  const [groupId, setGroupId] = useState<string | null>(initialGroupId)
  const [preset, setPreset] = useState<Preset>('today')
  const [customFrom, setCustomFrom] = useState(() =>
    ymd(rangeFromPreset('7d').from),
  )
  const [customTo, setCustomTo] = useState(() => ymd(startOfDay(new Date())))
  // Committed query that actually drives the report fetch. Handlers update it
  // (group change, preset change, custom "Показать"), so editing the custom
  // date inputs never refetches on every keystroke — only on apply. Seeded with
  // "today" for the initial group so the default report loads immediately.
  const [reportQuery, setReportQuery] = useState<
    { groupId: string; from: string; to: string } | null
  >(() => {
    if (!initialGroupId) return null
    const r = rangeFromPreset('today')
    return {
      groupId: initialGroupId,
      from: r.from.toISOString(),
      to: r.to.toISOString(),
    }
  })

  // Report data via SWR, keyed by the committed query so switching back to a
  // previously viewed range is instant (cached). The browser's timezone offset
  // is sent so the server buckets days by the admin's local clock, not UTC —
  // which is also why we don't render analytics on the server.
  const { data: analytics = null, isValidating: pending } = useSWR(
    reportQuery
      ? ['group-analytics', reportQuery.groupId, reportQuery.from, reportQuery.to]
      : null,
    async ([, gid, from, to]) => {
      const tz = new Date().getTimezoneOffset()
      const res = await getGroupAnalyticsAction(gid, from, to, tz)
      if (res.ok && res.data) return res.data
      throw new Error(res.message ?? 'Не удалось загрузить отчёт.')
    },
    {
      revalidateOnFocus: false,
      onError: (e: unknown) =>
        toast.error(
          e instanceof Error ? e.message : 'Не удалось загрузить отчёт.',
        ),
    },
  )

  function currentRange(p: Preset): { from: string; to: string } {
    if (p === 'custom') {
      const from = startOfDay(new Date(customFrom + 'T00:00:00'))
      const toBase = startOfDay(new Date(customTo + 'T00:00:00'))
      const to = new Date(toBase)
      to.setDate(toBase.getDate() + 1) // inclusive end day → exclusive bound
      return { from: from.toISOString(), to: to.toISOString() }
    }
    const r = rangeFromPreset(p)
    return { from: r.from.toISOString(), to: r.to.toISOString() }
  }

  function runReport(nextGroupId: string | null, p: Preset) {
    if (!nextGroupId) {
      setReportQuery(null)
      return
    }
    const { from, to } = currentRange(p)
    setReportQuery({ groupId: nextGroupId, from, to })
  }

  function onGroupChange(id: string | null) {
    if (!id) return
    setGroupId(id)
    runReport(id, preset)
  }
  function onPresetChange(p: Preset) {
    setPreset(p)
    if (p !== 'custom') runReport(groupId, p)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Обзор"
        description="Сгруппируйте каналы по источникам и смотрите, сколько людей написали и куда именно."
        action={<ManageGroupsDialog groups={groups} channels={channels} />}
      />

      {groups.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted">
            <Layers className="size-6 text-muted-foreground" />
          </span>
          <div>
            <h2 className="font-medium">Ещё нет источников</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Создайте источник и добавьте в него Telegram, WhatsApp и онлайн-чат
              одного сайта — это нужно сделать один раз.
            </p>
          </div>
          <ManageGroupsDialog
            groups={groups}
            channels={channels}
            triggerLabel="Создать источник"
          />
        </Card>
      ) : (
        <>
          {/* Controls */}
          <Card className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Источник</Label>
                <Select value={groupId ?? ''} onValueChange={onGroupChange}>
                  <SelectTrigger className="h-10 w-full min-w-[240px] sm:w-[260px]">
                    {/* Base UI renders the raw value by default, so we map the
                        selected id back to its group name here. */}
                    <SelectValue placeholder="Выберите источник">
                      {(value) => (
                        <span className="flex items-center gap-2">
                          <Layers className="size-4 text-muted-foreground" />
                          <span className="truncate font-medium">
                            {groups.find((g) => g.id === value)?.name ??
                              'Выберите источник'}
                          </span>
                        </span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Период</Label>
                <div className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1">
                  {(
                    [
                      ['today', 'Сегодня'],
                      ['7d', '7 дней'],
                      ['30d', '30 дней'],
                      ['custom', 'Период'],
                    ] as [Preset, string][]
                  ).map(([p, label]) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => onPresetChange(p)}
                      className={cn(
                        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                        preset === p
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {preset === 'custom' ? (
              <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">С</Label>
                  <Input
                    type="date"
                    value={customFrom}
                    max={customTo}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="w-[160px]"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">По</Label>
                  <Input
                    type="date"
                    value={customTo}
                    min={customFrom}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="w-[160px]"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => runReport(groupId, 'custom')}
                  disabled={pending}
                >
                  Показать
                </Button>
              </div>
            ) : null}
          </Card>

          {pending ? (
            <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Загрузка отчёта…
            </Card>
          ) : analytics ? (
            <Report analytics={analytics} />
          ) : (
            <Card className="p-10 text-center text-sm text-muted-foreground">
              Выберите источник, чтобы увидеть отчёт.
            </Card>
          )}
        </>
      )}
    </div>
  )
}
