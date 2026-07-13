'use client'

import { useMemo, useState, useTransition } from 'react'
import useSWR from 'swr'
import { useRouter } from 'next/navigation'
import { Check, Layers, Loader2, Plus, Trash2, Users } from 'lucide-react'
import { channelIcon } from '@/components/channel-icons'
import { toast } from 'sonner'
import {
  createSourceGroupAction,
  deleteSourceGroupAction,
  getGroupAnalyticsAction,
  updateSourceGroupAction,
} from '@/app/actions/groups'
import { ActivityChart } from '@/components/analytics/activity-chart'
import { PageHeader, StatCard } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ChannelType } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { GroupAnalytics, SourceGroup } from '@/lib/data'

type ChannelOption = {
  id: string
  type: ChannelType
  name: string
  detail: string
}

type Preset = 'today' | '7d' | '30d' | 'custom'

const TYPE_LABEL: Record<ChannelType, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  livechat: 'Онлайн-чат',
  max: 'MAX',
  vk: 'VK',
}

const TYPE_DOT: Record<ChannelType, string> = {
  telegram: 'bg-sky-500',
  whatsapp: 'bg-emerald-500',
  livechat: 'bg-violet-500',
  max: 'bg-amber-500',
  vk: 'bg-blue-500',
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function rangeFromPreset(preset: Exclude<Preset, 'custom'>): {
  from: Date
  to: Date
} {
  const todayStart = startOfDay(new Date())
  const tomorrow = new Date(todayStart)
  tomorrow.setDate(todayStart.getDate() + 1)
  if (preset === 'today') return { from: todayStart, to: tomorrow }
  const from = new Date(todayStart)
  from.setDate(todayStart.getDate() - (preset === '7d' ? 6 : 29))
  return { from, to: tomorrow }
}

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
        action={
          <ManageGroupsDialog groups={groups} channels={channels} />
        }
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

function Report({ analytics }: { analytics: GroupAnalytics }) {
  // Блоки по типам мессенджеров больше не захардкожены под Telegram/WhatsApp/
  // Онлайн-чат: строим их из фактических данных и сортируем по убыванию лидов.
  // «Всего написали» закреплён первым, дальше — три самых активных канала.
  const CHANNEL_TYPES: ChannelType[] = [
    'telegram',
    'whatsapp',
    'livechat',
    'max',
    'vk',
  ]
  const topTypes = CHANNEL_TYPES.map((type) => ({
    type,
    people: analytics.byType[type].people,
    messages: analytics.byType[type].messages,
  }))
    .sort((a, b) => b.people - a.people)
    .slice(0, 3)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Всего написали"
          value={analytics.totalPeople}
          icon={Users}
          hint={`${analytics.totalMessages} сообщений`}
        />
        {topTypes.map((t) => (
          <StatCard
            key={t.type}
            label={TYPE_LABEL[t.type]}
            value={t.people}
            icon={channelIcon(t.type)}
            hint={`${t.messages} сообщений`}
          />
        ))}
      </div>

      <ActivityChart byDay={analytics.byDay} byHour={analytics.byHour} />

      <ChannelTable analytics={analytics} />
    </div>
  )
}

function ChannelTable({ analytics }: { analytics: GroupAnalytics }) {
  // byChannel уже отсортирован сервером по убыванию людей. Доля считается от
  // самого активного канала, чтобы нарисовать сравнительную полоску.
  const peak = Math.max(1, ...analytics.byChannel.map((c) => c.people))

  return (
    <Card className="p-5">
      <h2 className="font-medium">Куда писали</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Разбивка обращений по каждому каналу источника — от самого активного.
      </p>
      {analytics.byChannel.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          В источнике нет каналов.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {analytics.byChannel.map((c) => {
            const Icon = channelIcon(c.type)
            const pct = Math.round((c.people / peak) * 100)
            return (
              <div
                key={c.channelId}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-lg text-primary-foreground',
                        TYPE_DOT[c.type],
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {TYPE_LABEL[c.type]}
                      </p>
                    </div>
                  </div>
                  <p className="shrink-0 text-2xl font-semibold tabular-nums">
                    {c.people}
                  </p>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn('h-full rounded-full', TYPE_DOT[c.type])}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{c.people} чел.</span>
                  <span>{c.messages} со��бщений</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

/* ----------------------- Group management dialog ----------------------- */

function ManageGroupsDialog({
  groups,
  channels,
  triggerLabel = 'Управление источниками',
}: {
  groups: SourceGroup[]
  channels: ChannelOption[]
  triggerLabel?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()

  // Which group currently owns each channel (to show a hint on the toggle).
  const ownerByChannel = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of groups) for (const c of g.channels) m.set(c.id, g.name)
    return m
  }, [groups])

  function resetForm() {
    setEditingId(null)
    setName('')
    setSelected(new Set())
  }

  function startEdit(g: SourceGroup) {
    setEditingId(g.id)
    setName(g.name)
    setSelected(new Set(g.channels.map((c) => c.id)))
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function submit() {
    const ids = [...selected]
    startTransition(async () => {
      const res = editingId
        ? await updateSourceGroupAction(editingId, name, ids)
        : await createSourceGroupAction(name, ids)
      if (res.ok) {
        toast.success(res.message)
        resetForm()
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  function remove(id: string) {
    // Источник теперь единая сущность: удаление снесёт и его финансы (кабинеты,
    // расходы, хранилище) в «Учёте», а не только привязку каналов. Предупреждаем.
    const ok = window.confirm(
      'Удалить источник целиком?\n\nВместе с ним из «Учёта» удалятся все рекламные кабинеты, расходы и данные хранилища этого источника. Это действие необратимо.',
    )
    if (!ok) return
    startTransition(async () => {
      const res = await deleteSourceGroupAction(id)
      if (res.ok) {
        toast.success(res.message)
        if (editingId === id) resetForm()
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) resetForm()
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" className="gap-1.5">
            <Layers className="size-4" />
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent className="flex max-h-[90vh] w-[min(720px,96vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(720px,96vw)]">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>Источники</DialogTitle>
          <DialogDescription>
            Объедините каналы одного сайта в источник. Группировка влияет только
            на отчёт в обзоре и не затрагивает входящие.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* Existing groups */}
          {groups.length > 0 ? (
            <ul className="mb-5 flex flex-col gap-2">
              {groups.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{g.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {g.channels.length > 0
                        ? g.channels
                            .map((c) => `${TYPE_LABEL[c.type]}: ${c.name}`)
                            .join(' · ')
                        : 'Нет каналов'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(g)}
                    >
                      Изменить
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(g.id)}
                      disabled={pending}
                      aria-label="Удалить источник"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {/* Create / edit form */}
          <div className="rounded-lg border border-border p-4">
            <p className="mb-3 text-sm font-medium">
              {editingId ? 'Редактирование источника' : 'Новый источник'}
            </p>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="group-name" className="text-xs">
                  Название
                </Label>
                <Input
                  id="group-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Например: Сайт acme.com"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Каналы источника</Label>
                {channels.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Сначала подключите каналы (Telegram, WhatsApp, онлайн-чат).
                  </p>
                ) : (
                  <div className="flex max-h-[260px] flex-col gap-1.5 overflow-y-auto">
                    {channels.map((c) => {
                      const on = selected.has(c.id)
                      const owner = ownerByChannel.get(c.id)
                      const takenByOther =
                        owner &&
                        (!editingId || !selected.has(c.id)) &&
                        owner !== groups.find((g) => g.id === editingId)?.name
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggle(c.id)}
                          className={cn(
                            'flex items-center justify-between gap-3 rounded-md border p-2.5 text-left transition-colors',
                            on
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:bg-muted/50',
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span
                              className={cn(
                                'size-2.5 shrink-0 rounded-full',
                                TYPE_DOT[c.type],
                              )}
                              aria-hidden
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">
                                {c.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {TYPE_LABEL[c.type]}
                                {c.detail ? ` · ${c.detail}` : ''}
                                {takenByOther ? ` · сейчас в «${owner}»` : ''}
                              </span>
                            </span>
                          </span>
                          <span
                            className={cn(
                              'flex size-5 shrink-0 items-center justify-center rounded-full border',
                              on
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border',
                            )}
                          >
                            {on ? <Check className="size-3.5" /> : null}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                {editingId ? (
                  <Button variant="outline" onClick={resetForm} disabled={pending}>
                    Отмена
                  </Button>
                ) : null}
                <Button onClick={submit} disabled={pending || !name.trim()}>
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : editingId ? null : (
                    <Plus className="size-4" />
                  )}
                  {editingId ? 'Сохранить' : 'Создать источник'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
