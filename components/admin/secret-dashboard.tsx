'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Activity,
  Antenna,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Copy,
  Database,
  Globe,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Pause,
  Phone,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react'
import {
  secretCreateChannelAction,
  secretCreateConversationAction,
  secretDeleteChannelAction,
  secretDeleteConversationAction,
  secretSendMessageAction,
  secretSetChannelStatusAction,
  secretSetConversationStatusAction,
  secretSetManagerStatusAction,
  secretToggleChannelIngestAction,
  type ActionResult,
} from '@/app/actions/admin-secret'
import { StatusBadge, SessionBadge, StatCard, EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { Channel, Manager } from '@/lib/types'
import { MessagesTrendChart, ChannelsTypeChart } from '@/components/admin/secret-charts'

export interface SecretConversation {
  id: string
  contactName: string
  contactHandle: string
  lastMessage: string
  unread: number
  status: string
  channelId: string
  channelType: string
  managerId: string | null
  lastMessageAt: string
}

export interface SecretStats {
  managersTotal: number
  managersActive: number
  managersOnLunch: number
  channelsTotal: number
  channelsConnected: number
  conversationsTotal: number
  unreadTotal: number
  messagesTotal: number
  messages24h: number
  channelsByType: { type: string; count: number }[]
  conversationsByStatus: { status: string; count: number }[]
  messages7d: { day: string; label: string; incoming: number; outgoing: number }[]
}

interface SecretSystem {
  workerConfigured: boolean
  workerOnline: boolean
  dbOk: boolean
  dbMessage: string
  generatedAt: string
}

const TYPE_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

const TYPE_ICON: Record<string, typeof Send> = {
  telegram: Send,
  whatsapp: Phone,
  vk: Users,
  max: MessageSquare,
  livechat: Globe,
}

const CONV_STATUS_LABEL: Record<string, string> = {
  liquid: 'Ликвид',
  not_liquid: 'Не ликвид',
  unsubscribed: 'Отписка',
  transferred: 'Передан',
}

const CONV_STATUS_STYLE: Record<string, string> = {
  liquid: 'bg-success/15 text-success',
  not_liquid: 'bg-warning/15 text-warning',
  unsubscribed: 'bg-muted text-muted-foreground',
  transferred: 'bg-chart-2/15 text-foreground',
}

/** Module-level so the React Compiler never treats it as reactive state. */
function copyText(text: string, label = 'ID') {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    toast.error('Буфер обмена недоступен')
    return
  }
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${label} скопирован`))
    .catch(() => toast.error('Не удалось скопировать'))
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function convStatusLabel(status: string): string {
  return CONV_STATUS_LABEL[status] ?? status
}

export function SecretDashboard({
  managers,
  channels,
  conversations,
  stats,
  system,
}: {
  managers: Manager[]
  channels: Channel[]
  conversations: SecretConversation[]
  stats: SecretStats
  system: SecretSystem
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [autoRefresh, setAutoRefresh] = useState(true)

  // Live refresh: re-run the RSC every 20s so metrics/tables stay current
  // without any client-side fetching. Pausable to avoid churn while typing.
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => router.refresh(), 20_000)
    return () => clearInterval(id)
  }, [autoRefresh, router])

  function run(action: () => Promise<ActionResult>, onDone?: () => void) {
    startTransition(async () => {
      try {
        const res = await action()
        if (res.ok) {
          toast.success(res.message)
          onDone?.()
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      router.refresh()
    })
  }

  const managerName = useMemo(() => {
    const map = new Map(managers.map((m) => [m.id, m.name]))
    return (id: string | null) => (id ? map.get(id) ?? '—' : '—')
  }, [managers])

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 p-4 md:p-8">
      <SecretHeader
        system={system}
        pending={pending}
        autoRefresh={autoRefresh}
        onToggleAuto={() => setAutoRefresh((v) => !v)}
        onRefresh={() => router.refresh()}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Менеджеры"
          value={stats.managersTotal}
          icon={Users}
          hint={`${stats.managersActive} активны · ${stats.managersOnLunch} на обеде`}
        />
        <StatCard
          label="Каналы"
          value={stats.channelsTotal}
          icon={Antenna}
          hint={`${stats.channelsConnected} подключено`}
        />
        <StatCard
          label="Диалоги"
          value={stats.conversationsTotal}
          icon={MessagesSquare}
          hint={`${stats.unreadTotal} непрочитанных`}
        />
        <StatCard
          label="Сообщения (24ч)"
          value={stats.messages24h}
          icon={Activity}
          hint={`${stats.messagesTotal} всего`}
        />
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="flex w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="overview">Обзор</TabsTrigger>
          <TabsTrigger value="managers">Менеджеры</TabsTrigger>
          <TabsTrigger value="channels">Каналы</TabsTrigger>
          <TabsTrigger value="conversations">Диалоги</TabsTrigger>
          <TabsTrigger value="console">Консоль</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab stats={stats} />
        </TabsContent>
        <TabsContent value="managers" className="mt-4">
          <ManagersTab managers={managers} pending={pending} run={run} />
        </TabsContent>
        <TabsContent value="channels" className="mt-4">
          <ChannelsTab
            channels={channels}
            managers={managers}
            managerName={managerName}
            pending={pending}
            run={run}
          />
        </TabsContent>
        <TabsContent value="conversations" className="mt-4">
          <ConversationsTab
            conversations={conversations}
            channels={channels}
            pending={pending}
            run={run}
          />
        </TabsContent>
        <TabsContent value="console" className="mt-4">
          <ConsoleTab conversations={conversations} pending={pending} run={run} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ------------------------------- Header ------------------------------- */

function SecretHeader({
  system,
  pending,
  autoRefresh,
  onToggleAuto,
  onRefresh,
}: {
  system: SecretSystem
  pending: boolean
  autoRefresh: boolean
  onToggleAuto: () => void
  onRefresh: () => void
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-muted/40">
          <ShieldCheck className="size-5 text-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
            Панель супер-администратора
          </h1>
          <p className="text-sm text-muted-foreground">
            Прямое управление менеджерами, каналами и диалогами
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SystemPill
          ok={system.dbOk}
          icon={Database}
          okText="База данных"
          badText="БД недоступна"
        />
        <SystemPill
          ok={system.workerOnline}
          icon={Server}
          okText="Воркер в сети"
          badText={system.workerConfigured ? 'Воркер оффлайн' : 'Воркер не настроен'}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={onToggleAuto}
          className={cn('gap-1.5', autoRefresh && 'border-success/40 text-success')}
        >
          <Activity className="size-4" />
          {autoRefresh ? 'Авто 20с' : 'Авто выкл'}
        </Button>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={pending} className="gap-1.5">
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Обновить
        </Button>
      </div>
    </div>
  )
}

function SystemPill({
  ok,
  icon: Icon,
  okText,
  badText,
}: {
  ok: boolean
  icon: typeof Database
  okText: string
  badText: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        ok
          ? 'border-success/30 bg-success/10 text-success'
          : 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      <Icon className="size-3.5" />
      {ok ? okText : badText}
    </span>
  )
}

/* ------------------------------ Overview ------------------------------ */

function OverviewTab({ stats }: { stats: SecretStats }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-medium">Сообщения за 7 дней</h3>
          <MessagesSquare className="size-4 text-muted-foreground" />
        </div>
        <MessagesTrendChart data={stats.messages7d} />
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-medium">Каналы по типам</h3>
          <Antenna className="size-4 text-muted-foreground" />
        </div>
        {stats.channelsByType.length ? (
          <ChannelsTypeChart data={stats.channelsByType} />
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Нет каналов
          </p>
        )}
      </Card>

      <Card className="p-5 lg:col-span-2">
        <h3 className="mb-4 font-medium">Диалоги по статусам</h3>
        {stats.conversationsByStatus.length ? (
          <div className="flex flex-wrap gap-2">
            {stats.conversationsByStatus.map((s) => (
              <span
                key={s.status}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium',
                  CONV_STATUS_STYLE[s.status] ?? 'bg-muted text-muted-foreground',
                )}
              >
                {convStatusLabel(s.status)}
                <span className="tabular-nums opacity-80">{s.count}</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Нет диалогов</p>
        )}
      </Card>
    </div>
  )
}

/* ------------------------------ Managers ------------------------------ */

function ManagersTab({
  managers,
  pending,
  run,
}: {
  managers: Manager[]
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [q, setQ] = useState('')
  const filtered = managers.filter(
    (m) =>
      m.name.toLowerCase().includes(q.toLowerCase()) ||
      m.email.toLowerCase().includes(q.toLowerCase()),
  )

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по имени или email"
            className="pl-8"
          />
        </div>
        <Link
          href="/admin/managers"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
        >
          Управление менеджерами
          <ArrowUpRight className="size-4" />
        </Link>
      </div>

      {filtered.length ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Имя</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead className="text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {m.name}
                      {m.onLunch ? (
                        <Badge variant="outline" className="border-warning/40 text-warning">
                          На обеде
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.email}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        m.status === 'active'
                          ? 'border-success/40 bg-success/10 text-success'
                          : 'border-destructive/40 bg-destructive/10 text-destructive',
                      )}
                    >
                      {m.status === 'active' ? 'Активен' : 'Заблокирован'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyText(m.id)}
                        className="gap-1.5"
                      >
                        <Copy className="size-3.5" />
                        ID
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          run(() =>
                            secretSetManagerStatusAction(
                              m.id,
                              m.status === 'active' ? 'blocked' : 'active',
                            ),
                          )
                        }
                        className={cn(
                          'gap-1.5',
                          m.status === 'active' && 'text-destructive',
                        )}
                      >
                        {m.status === 'active' ? (
                          <>
                            <Ban className="size-3.5" /> Блок
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="size-3.5" /> Разблок
                          </>
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="p-6">
          <EmptyState
            icon={Users}
            title="Менеджеры не найдены"
            description="Измените запрос поиска или создайте менеджера в разделе управления."
          />
        </div>
      )}
    </Card>
  )
}

/* ------------------------------ Channels ------------------------------ */

function ChannelsTab({
  channels,
  managers,
  managerName,
  pending,
  run,
}: {
  channels: Channel[]
  managers: Manager[]
  managerName: (id: string | null) => string
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const filtered = channels.filter((c) => {
    const matchesQ =
      c.name.toLowerCase().includes(q.toLowerCase()) ||
      (c.detail ?? '').toLowerCase().includes(q.toLowerCase())
    const matchesType = typeFilter === 'all' || c.type === typeFilter
    return matchesQ && matchesType
  })

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск канала"
              className="pl-8"
            />
          </div>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? 'all')}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все типы</SelectItem>
              {Object.entries(TYPE_LABEL).map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CreateChannelDialog managers={managers} pending={pending} run={run} />
      </div>

      {filtered.length ? (
        <div className="divide-y divide-border">
          {filtered.map((ch) => {
            const Icon = TYPE_ICON[ch.type] ?? Antenna
            return (
              <div
                key={ch.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                    <Icon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{ch.name}</span>
                      <Badge variant="secondary">{TYPE_LABEL[ch.type] ?? ch.type}</Badge>
                      <StatusBadge status={ch.status} />
                      {ch.type === 'telegram' || ch.type === 'whatsapp' ? (
                        <SessionBadge status={ch.sessionStatus} />
                      ) : null}
                      {ch.ingestPaused ? (
                        <Badge variant="outline" className="border-warning/40 text-warning">
                          Приём на паузе
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {ch.detail || '—'} · Владелец: {managerName(ch.managerId)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyText(ch.id)}
                    className="gap-1.5"
                  >
                    <Copy className="size-3.5" /> ID
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => run(() => secretToggleChannelIngestAction(ch.id))}
                    className="gap-1.5"
                  >
                    {ch.ingestPaused ? (
                      <>
                        <Play className="size-3.5" /> Возобновить
                      </>
                    ) : (
                      <>
                        <Pause className="size-3.5" /> Пауза
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      run(() =>
                        secretSetChannelStatusAction(
                          ch.id,
                          ch.status === 'connected' ? 'disconnected' : 'connected',
                        ),
                      )
                    }
                    className="gap-1.5"
                  >
                    <Antenna className="size-3.5" />
                    {ch.status === 'connected' ? 'Отключить' : 'Подключить'}
                  </Button>
                  <ConfirmDeleteButton
                    label="канал"
                    name={ch.name}
                    pending={pending}
                    onConfirm={() => run(() => secretDeleteChannelAction(ch.id))}
                  />
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="p-6">
          <EmptyState
            icon={Antenna}
            title="Каналы не найдены"
            description="Создайте новый канал или измените фильтры."
          />
        </div>
      )}
    </Card>
  )
}

function CreateChannelDialog({
  managers,
  pending,
  run,
}: {
  managers: Manager[]
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    name: '',
    type: 'telegram',
    managerId: '',
    phone: '',
    token: '',
    groupId: '',
  })

  return (
    <>
      <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Новый канал
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Создать канал</DialogTitle>
          <DialogDescription>
            Ручное создание записи канала. Для реального подключения Telegram/WhatsApp
            используйте мастер в разделе «Аккаунты».
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Название</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Напр. Основной Telegram"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Тип</Label>
              <Select
                value={form.type}
                onValueChange={(v) => setForm({ ...form, type: v ?? '' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Владелец</Label>
              <Select
                value={form.managerId}
                onValueChange={(v) => setForm({ ...form, managerId: v ?? '' })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Менеджер" />
                </SelectTrigger>
                <SelectContent>
                  {managers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Телефон / деталь</Label>
            <Input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="Необязательно"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () => secretCreateChannelAction(form),
                () => {
                  setOpen(false)
                  setForm({
                    name: '',
                    type: 'telegram',
                    managerId: '',
                    phone: '',
                    token: '',
                    groupId: '',
                  })
                },
              )
            }
            className="gap-1.5"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  )
}

/* ---------------------------- Conversations --------------------------- */

function ConversationsTab({
  conversations,
  channels,
  pending,
  run,
}: {
  conversations: SecretConversation[]
  channels: Channel[]
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [q, setQ] = useState('')
  const filtered = conversations.filter(
    (c) =>
      c.contactName.toLowerCase().includes(q.toLowerCase()) ||
      c.contactHandle.toLowerCase().includes(q.toLowerCase()) ||
      c.lastMessage.toLowerCase().includes(q.toLowerCase()),
  )

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по контакту или тексту"
            className="pl-8"
          />
        </div>
        <CreateConversationDialog channels={channels} pending={pending} run={run} />
      </div>

      {filtered.length ? (
        <div className="divide-y divide-border">
          {filtered.map((conv) => (
            <div
              key={conv.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{conv.contactName}</span>
                  <span className="text-sm text-muted-foreground">{conv.contactHandle}</span>
                  <Badge variant="secondary">{TYPE_LABEL[conv.channelType] ?? conv.channelType}</Badge>
                  <span
                    className={cn(
                      'rounded-md px-2 py-0.5 text-xs font-medium',
                      CONV_STATUS_STYLE[conv.status] ?? 'bg-muted text-muted-foreground',
                    )}
                  >
                    {convStatusLabel(conv.status)}
                  </span>
                  {conv.unread > 0 ? (
                    <Badge className="bg-primary text-primary-foreground">
                      {conv.unread} новых
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">
                  {conv.lastMessage || '—'} · {fmtDateTime(conv.lastMessageAt)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Select
                  value={conv.status}
                  onValueChange={(v) => {
                    if (v) run(() => secretSetConversationStatusAction(conv.id, v))
                  }}
                >
                  <SelectTrigger className="h-8 w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CONV_STATUS_LABEL).map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyText(conv.id)}
                  className="gap-1.5"
                >
                  <Copy className="size-3.5" /> ID
                </Button>
                <ConfirmDeleteButton
                  label="диалог"
                  name={conv.contactName}
                  pending={pending}
                  onConfirm={() => run(() => secretDeleteConversationAction(conv.id))}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-6">
          <EmptyState
            icon={MessagesSquare}
            title="Диалоги не найдены"
            description="Создайте новый диалог или измените запрос."
          />
        </div>
      )}
    </Card>
  )
}

function CreateConversationDialog({
  channels,
  pending,
  run,
}: {
  channels: Channel[]
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    channelId: '',
    contactName: '',
    contactHandle: '',
    message: '',
  })

  return (
    <>
      <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Новый диалог
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Создать диалог</DialogTitle>
          <DialogDescription>
            Диалог привязывается к каналу и его владельцу.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Канал</Label>
            <Select
              value={form.channelId}
              onValueChange={(v) => setForm({ ...form, channelId: v ?? '' })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Выберите канал" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((ch) => (
                  <SelectItem key={ch.id} value={ch.id}>
                    {ch.name} · {TYPE_LABEL[ch.type] ?? ch.type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Имя контакта</Label>
              <Input
                value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Хэндл</Label>
              <Input
                value={form.contactHandle}
                onChange={(e) => setForm({ ...form, contactHandle: e.target.value })}
                placeholder="@user / +7…"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Первое сообщение</Label>
            <Textarea
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              placeholder="Необязательно"
              className="resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () => secretCreateConversationAction(form),
                () => {
                  setOpen(false)
                  setForm({ channelId: '', contactName: '', contactHandle: '', message: '' })
                },
              )
            }
            className="gap-1.5"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  )
}

/* ------------------------------- Console ------------------------------ */

function ConsoleTab({
  conversations,
  pending,
  run,
}: {
  conversations: SecretConversation[]
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [form, setForm] = useState({
    conversationId: '',
    body: '',
    direction: 'out',
  })

  return (
    <Card className="mx-auto max-w-2xl p-5">
      <div className="mb-4 flex items-center gap-2">
        <MessageSquare className="size-4 text-muted-foreground" />
        <h3 className="font-medium">Вставка сообщения в диалог</h3>
      </div>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label>Диалог</Label>
          <Select
            value={form.conversationId}
            onValueChange={(v) => setForm({ ...form, conversationId: v ?? '' })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Выберите диалог" />
            </SelectTrigger>
            <SelectContent>
              {conversations.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.contactName} · {c.contactHandle}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Направление</Label>
          <Select
            value={form.direction}
            onValueChange={(v) => setForm({ ...form, direction: v ?? 'out' })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="out">Исходящее (от менеджера)</SelectItem>
              <SelectItem value="in">Входящее (от клиента)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Текст</Label>
          <Textarea
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder="Текст сообщения"
            className="min-h-24 resize-none"
          />
        </div>
        <Button
          disabled={pending}
          onClick={() =>
            run(
              () => secretSendMessageAction(form),
              () => setForm({ ...form, body: '' }),
            )
          }
          className="gap-1.5"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Добавить сообщение
        </Button>
      </div>
    </Card>
  )
}

/* ------------------------------ Shared UI ----------------------------- */

function ConfirmDeleteButton({
  label,
  name,
  pending,
  onConfirm,
}: {
  label: string
  name: string
  pending: boolean
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-3.5" /> Удалить
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Удалить {label}?</DialogTitle>
          <DialogDescription>
            «{name}» будет удалён безвозвратно вместе со связанными данными.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              onConfirm()
              setOpen(false)
            }}
            className="gap-1.5"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Удалить
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  )
}
