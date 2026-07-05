'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Check,
  Layers,
  Loader2,
  MessageCircle,
  Phone,
  Plus,
  Send,
  Trash2,
  Users,
} from 'lucide-react'
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
  const [analytics, setAnalytics] = useState<GroupAnalytics | null>(null)
  const [pending, startTransition] = useTransition()

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

  function load(nextGroupId: string | null, p: Preset) {
    if (!nextGroupId) {
      setAnalytics(null)
      return
    }
    const { from, to } = currentRange(p)
    // The browser knows the admin's timezone; the server buckets days with it
    // so "today" matches the local clock instead of the server's UTC date.
    const tz = new Date().getTimezoneOffset()
    startTransition(async () => {
      const res = await getGroupAnalyticsAction(nextGroupId, from, to, tz)
      if (res.ok && res.data) setAnalytics(res.data)
      else toast.error(res.message ?? 'Не удалось загрузить отчёт.')
    })
  }

  // Load the default report ("today") once on mount, using the client's real
  // timezone. We deliberately don't render analytics on the server because it
  // would compute "today" in UTC and be off by a day for the admin.
  useEffect(() => {
    if (initialGroupId) load(initialGroupId, 'today')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onGroupChange(id: string | null) {
    if (!id) return
    setGroupId(id)
    load(id, preset)
  }
  function onPresetChange(p: Preset) {
    setPreset(p)
    if (p !== 'custom') load(groupId, p)
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
                  onClick={() => load(groupId, 'custom')}
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
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Всего написали"
          value={analytics.totalPeople}
          icon={Users}
          hint={`${analytics.totalMessages} сообщений`}
        />
        <StatCard
          label="Telegram"
          value={analytics.byType.telegram.people}
          icon={Send}
          hint={`${analytics.byType.telegram.messages} сообщений`}
        />
        <StatCard
          label="WhatsApp"
          value={analytics.byType.whatsapp.people}
          icon={Phone}
          hint={`${analytics.byType.whatsapp.messages} сообщений`}
        />
        <StatCard
          label="Онлайн-чат"
          value={analytics.byType.livechat.people}
          icon={MessageCircle}
          hint={`${analytics.byType.livechat.messages} сообщений`}
        />
      </div>

      <ActivityChart byDay={analytics.byDay} byHour={analytics.byHour} />

      <ChannelTable analytics={analytics} />
    </div>
  )
}

function ChannelTable({ analytics }: { analytics: GroupAnalytics }) {
  return (
    <Card className="p-5">
      <h2 className="font-medium">Куда писали</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Разбивка обращений по каждому каналу источника.
      </p>
      {analytics.byChannel.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          В источнике нет каналов.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {analytics.byChannel.map((c) => (
            <li
              key={c.channelId}
              className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn('size-2.5 shrink-0 rounded-full', TYPE_DOT[c.type])}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {TYPE_LABEL[c.type]}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-6 text-right">
                <div>
                  <p className="text-base font-semibold tabular-nums">
                    {c.people}
                  </p>
                  <p className="text-[11px] text-muted-foreground">человек</p>
                </div>
                <div>
                  <p className="text-base font-semibold tabular-nums">
                    {c.messages}
                  </p>
                  <p className="text-[11px] text-muted-foreground">сообщений</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
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
