'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Activity,
  Antenna,
  ArrowLeftRight,
  ArrowUpRight,
  Ban,
  Bot,
  CheckCircle2,
  Copy,
  Database,
  Loader2,
  MessagesSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Target,
  Eraser,
  Lock,
  Sparkles,
  Trash2,
  TriangleAlert,
  Users,
  Wallet,
  Zap,
} from 'lucide-react'
import { ChannelIcon } from '@/components/channel-icons'
import {
  secretBulkCreateConversationsAction,
  secretCreateChannelAction,
  secretDeleteChannelAction,
  secretLockAction,
  secretSetNamesHiddenAction,
  secretSetChannelStatusAction,
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
import { SecretConsole } from '@/components/admin/secret-console'
import { SecretSimulatorTab } from '@/components/admin/secret-simulator-tab'
import { SecretTransferTab } from '@/components/admin/secret-transfer-tab'
import {
  SecretAdsTab,
  type SecretAdAccount,
} from '@/components/admin/secret-ads-tab'

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
  gateEnabled: boolean
  /** Remaining AI Gateway credit in USD (null when unavailable). */
  aiBalance: number | null
  /** Lifetime AI spend in USD (null when unavailable). */
  aiTotalUsed: number | null
  /** True when the balance figures are real (key present, request ok). */
  aiBalanceOk: boolean
  /** Why the balance is unavailable, if so. */
  aiBalanceMessage: string | null
}

const TYPE_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
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

function convStatusLabel(status: string): string {
  return CONV_STATUS_LABEL[status] ?? status
}

export function SecretDashboard({
  managers,
  channels,
  stats,
  system,
  namesHidden,
  adAccounts,
}: {
  managers: Manager[]
  channels: Channel[]
  stats: SecretStats
  system: SecretSystem
  namesHidden: boolean
  adAccounts: SecretAdAccount[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [autoRefresh, setAutoRefresh] = useState(true)

  // Live refresh: re-run the RSC every 20s so metrics/tables stay current
  // without any client-side fetching. Pausable to avoid churn while typing.
  // Skipped while the tab is hidden so a backgrounded dashboard doesn't keep
  // hammering the server (each refresh re-runs the whole RSC + its DB queries);
  // we refresh once immediately when the tab becomes visible again.
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
    }, 20_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') router.refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
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
        onLock={() => {
          void secretLockAction().then(() => router.refresh())
        }}
      />

      <AiBalanceBanner system={system} />

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

      <Tabs defaultValue="console" className="w-full">
        {/*
          Single-row, horizontally-scrollable tab strip. On narrow screens the
          7 triggers used to wrap into a ragged 3-row block; a scrollable strip
          keeps them on one clean line (with a subtle overflow hint) and lets
          them size naturally on desktop. `shrink-0` stops labels from being
          squeezed; `-mx-1 px-1` gives the focus ring room at the edges.
        */}
        <TabsList className="no-scrollbar -mx-1 flex w-[calc(100%+0.5rem)] justify-start gap-1 overflow-x-auto px-1 md:mx-0 md:w-full md:flex-wrap">
          <TabsTrigger value="console" className="shrink-0">
            Диалоги
          </TabsTrigger>
          <TabsTrigger value="bulk" className="shrink-0 gap-1.5">
            <Zap className="size-3.5" />
            Наплыв
          </TabsTrigger>
          <TabsTrigger value="simulator" className="shrink-0 gap-1.5">
            <Bot className="size-3.5" />
            Симулятор
          </TabsTrigger>
          <TabsTrigger value="overview" className="shrink-0">
            Обзор
          </TabsTrigger>
          <TabsTrigger value="managers" className="shrink-0">
            Менеджеры
          </TabsTrigger>
          <TabsTrigger value="transfer" className="shrink-0 gap-1.5">
            <ArrowLeftRight className="size-3.5" />
            Передача
          </TabsTrigger>
          <TabsTrigger value="channels" className="shrink-0">
            Каналы
          </TabsTrigger>
          <TabsTrigger value="ads" className="shrink-0 gap-1.5">
            <Target className="size-3.5" />
            Реклама
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab stats={stats} />
        </TabsContent>
        <TabsContent value="managers" className="mt-4">
          <ManagersTab managers={managers} pending={pending} run={run} />
        </TabsContent>
        <TabsContent value="transfer" className="mt-4">
          <SecretTransferTab managers={managers} />
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
        <TabsContent value="ads" className="mt-4">
          <SecretAdsTab accounts={adAccounts} />
        </TabsContent>
        <TabsContent value="console" className="mt-4">
          <SecretConsole channels={channels} managers={managers} />
        </TabsContent>
        <TabsContent value="simulator" className="mt-4">
          <SecretSimulatorTab channels={channels} />
        </TabsContent>
        <TabsContent value="bulk" className="mt-4">
          <MassImportTab
            channels={channels}
            managerName={managerName}
            pending={pending}
            run={run}
            namesHidden={namesHidden}
          />
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
  onLock,
}: {
  system: SecretSystem
  pending: boolean
  autoRefresh: boolean
  onToggleAuto: () => void
  onRefresh: () => void
  onLock: () => void
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
        <AiBalancePill system={system} />
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
        {system.gateEnabled && (
          <Button
            variant="outline"
            size="sm"
            onClick={onLock}
            className="press-scale gap-1.5"
          >
            <Lock className="size-4" />
            Заблокировать
          </Button>
        )}
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

/**
 * Live AI Gateway balance pill. Both the manager brain and the simulator bill
 * against the same key, so this one figure is the whole system's remaining AI
 * budget. Turns amber when funds run low and red when unavailable/empty.
 */
function AiBalancePill({ system }: { system: SecretSystem }) {
  const { aiBalanceOk, aiBalance, aiTotalUsed, aiBalanceMessage } = system

  if (!aiBalanceOk || aiBalance == null) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground"
        title={aiBalanceMessage ?? 'Баланс ИИ недоступен'}
      >
        <Wallet className="size-3.5" />
        Баланс ИИ н/д
      </span>
    )
  }

  const low = aiBalance < 5
  const empty = aiBalance <= 0
  const usd = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        empty
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : low
            ? 'border-warning/30 bg-warning/10 text-warning'
            : 'border-success/30 bg-success/10 text-success',
      )}
      title={
        aiTotalUsed != null
          ? `Остаток на ИИ (менеджер + симулятор). Потрачено всего: ${usd(aiTotalUsed)}`
          : 'Остаток на ИИ (менеджер + симулятор)'
      }
    >
      <Wallet className="size-3.5" />
      Баланс ИИ: {usd(aiBalance)}
    </span>
  )
}

/**
 * Prominent, always-visible balance panel. Both AIs (менеджер + симулятор) spend
 * from the same AI Gateway key, so this is the whole system's remaining budget.
 * Shown right under the header so it can't be missed on mobile.
 */
function AiBalanceBanner({ system }: { system: SecretSystem }) {
  const { aiBalanceOk, aiBalance, aiTotalUsed, aiBalanceMessage } = system
  const usd = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // Unavailable: no key / request failed. Neutral card with the reason.
  if (!aiBalanceOk || aiBalance == null) {
    return (
      <Card className="flex items-center gap-3 border-dashed p-4">
        <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Wallet className="size-5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">Баланс ИИ недоступен</p>
          <p className="truncate text-xs text-muted-foreground">
            {aiBalanceMessage ??
              'Задайте AI_GATEWAY_API_KEY, чтобы видеть остаток средств'}
          </p>
        </div>
      </Card>
    )
  }

  const empty = aiBalance <= 0
  const low = aiBalance < 5
  const tone = empty
    ? 'border-destructive/40 bg-destructive/5'
    : low
      ? 'border-warning/40 bg-warning/5'
      : 'border-success/40 bg-success/5'
  const iconTone = empty
    ? 'text-destructive'
    : low
      ? 'text-warning'
      : 'text-success'

  return (
    <Card className={cn('flex flex-wrap items-center gap-4 p-4', tone)}>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex size-11 items-center justify-center rounded-xl border border-border bg-background/60',
            iconTone,
          )}
        >
          <Wallet className="size-5" />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Баланс ИИ (менеджер + симулятор)
          </p>
          <p className={cn('text-2xl font-semibold tabular-nums', iconTone)}>
            {usd(aiBalance)}
          </p>
        </div>
      </div>

      {aiTotalUsed != null && (
        <div className="ml-auto text-right">
          <p className="text-xs font-medium text-muted-foreground">
            Потрачено всего
          </p>
          <p className="text-lg font-semibold tabular-nums">
            {usd(aiTotalUsed)}
          </p>
        </div>
      )}

      {empty ? (
        <p className="w-full text-xs font-medium text-destructive">
          Средства закончились — ИИ перестанет отвечать. Пополните баланс AI
          Gateway.
        </p>
      ) : low ? (
        <p className="w-full text-xs font-medium text-warning">
          Низкий остаток — скоро потребуется пополнение.
        </p>
      ) : null}
    </Card>
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

/* --------------------------- Mass import ------------------------------ */

const HOUR_PRESETS: { label: string; hours: number }[] = [
  { label: '1ч', hours: 1 },
  { label: '6ч', hours: 6 },
  { label: '24ч', hours: 24 },
  { label: '7д', hours: 168 },
  { label: '30д', hours: 720 },
]

const COUNT_PRESETS = [10, 25, 50, 100]

/** Human-readable RU label for a span given in hours. */
function formatHours(hours: number): string {
  if (hours <= 0) return 'текущий момент'
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`
  const days = Math.round((hours / 24) * 10) / 10
  const whole = Number.isInteger(days) ? days : Math.round(days)
  return `${whole} ${plural(whole, 'день', 'дня', 'дней')}`
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

function MassImportTab({
  channels,
  managerName,
  pending,
  run,
  namesHidden,
}: {
  channels: Channel[]
  managerName: (id: string | null) => string
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
  namesHidden: boolean
}) {
  // Only channels with an owner can host a conversation.
  const eligible = useMemo(() => channels.filter((c) => c.managerId), [channels])

  const [count, setCount] = useState(10)
  const [spreadHours, setSpreadHours] = useState(24)
  const [withMessage, setWithMessage] = useState(true)
  const [markUnread, setMarkUnread] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(eligible.map((c) => c.id)),
  )

  const selectedIds = eligible.filter((c) => selected.has(c.id)).map((c) => c.id)
  const canGenerate = count > 0 && selectedIds.length > 0 && !pending

  function toggleChannel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function generate() {
    run(() =>
      secretBulkCreateConversationsAction({
        count,
        channelIds: selectedIds,
        spreadHours,
        withMessage,
        markUnread,
      }),
    )
  }

  if (eligible.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="Нет каналов с владельцем"
        description="Сначала создайте канал и назначьте ему менеджера — тогда можно массово наливать диалоги."
      />
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      {/* ---- Config ---- */}
      <Card className="flex flex-col gap-6 p-5">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40">
            <Sparkles className="size-5 text-foreground" />
          </div>
          <div>
            <h3 className="font-semibold tracking-tight">Массовое создание диалогов</h3>
            <p className="text-sm text-muted-foreground text-pretty">
              Сгенерируйте пачку диалогов с разных каналов и с разным временем —
              как внезапный наплыв обращений.
            </p>
          </div>
        </div>

        {/* Count */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-count">Сколько диалогов</Label>
          <div className="flex flex-wrap items-center gap-2">
            {COUNT_PRESETS.map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={count === p ? 'default' : 'outline'}
                className="press-scale"
                onClick={() => setCount(p)}
              >
                {p}
              </Button>
            ))}
            <Input
              id="bulk-count"
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) =>
                setCount(Math.min(Math.max(Number(e.target.value) || 0, 1), 100))
              }
              className="w-24"
            />
            <span className="text-xs text-muted-foreground">макс. 100 за раз</span>
          </div>
        </div>

        {/* Time window */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-hours">Разброс по времени (часов)</Label>
          <div className="flex flex-wrap items-center gap-2">
            {HOUR_PRESETS.map((h) => (
              <Button
                key={h.hours}
                type="button"
                size="sm"
                variant={spreadHours === h.hours ? 'default' : 'outline'}
                className="press-scale"
                onClick={() => setSpreadHours(h.hours)}
              >
                {h.label}
              </Button>
            ))}
            <Input
              id="bulk-hours"
              type="number"
              min={0}
              max={2160}
              value={spreadHours}
              onChange={(e) =>
                setSpreadHours(Math.min(Math.max(Number(e.target.value) || 0, 0), 2160))
              }
              className="w-24"
            />
            <span className="text-xs text-muted-foreground">макс. 2160 ч (90 дней)</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Время последнего сообщения распределится случайно за последние{' '}
            {formatHours(spreadHours)}.
          </p>
        </div>

        {/* Options */}
        <div className="flex flex-col gap-2">
          <Label>Параметры</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            <ToggleTile
              active={withMessage}
              onClick={() => setWithMessage((v) => !v)}
              title="С первым сообщением"
              description="Добавить входящее сообщение от клиента"
            />
            <ToggleTile
              active={markUnread}
              onClick={() => setMarkUnread((v) => !v)}
              disabled={!withMessage}
              title="Отметить непрочитанным"
              description="Поднять счётчик непрочитанных у менеджера"
            />
          </div>
        </div>

        {/* Channels */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label>Каналы-источник��</Label>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                className="text-foreground/70 underline-offset-2 hover:underline"
                onClick={() => setSelected(new Set(eligible.map((c) => c.id)))}
              >
                Все
              </button>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                className="text-foreground/70 underline-offset-2 hover:underline"
                onClick={() => setSelected(new Set())}
              >
                Сброс
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {eligible.map((c) => {
              const on = selected.has(c.id)
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleChannel(c.id)}
                  className={cn(
                    'press-scale inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    on
                      ? 'border-foreground/20 bg-foreground text-background'
                      : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
                  )}
                >
                  <ChannelIcon type={c.type} className="size-3.5" />
                  {c.name}
                </button>
              )
            })}
          </div>
        </div>
      </Card>

      {/* ---- Summary / action ---- */}
      <Card className="flex flex-col gap-5 p-5">
        <h3 className="font-semibold tracking-tight">Итог</h3>
        <div className="flex flex-col gap-3 text-sm">
          <SummaryRow label="Диалогов" value={String(count)} />
          <SummaryRow
            label="Каналов выбрано"
            value={`${selectedIds.length} из ${eligible.length}`}
          />
          <SummaryRow label="Окно времени" value={formatHours(spreadHours)} />
          <SummaryRow label="Сообщение" value={withMessage ? 'да' : 'нет'} />
          <SummaryRow
            label="Непрочитанные"
            value={withMessage && markUnread ? 'да' : 'нет'}
          />
        </div>

        {selectedIds.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Владельцы:{' '}
            {Array.from(
              new Set(
                eligible
                  .filter((c) => selected.has(c.id))
                  .map((c) => managerName(c.managerId)),
              ),
            ).join(', ')}
          </div>
        )}

        <Button
          size="lg"
          className="press-scale mt-auto gap-2"
          disabled={!canGenerate}
          onClick={generate}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Zap className="size-4" />
          )}
          Создать {count}{' '}
          {count % 10 === 1 && count % 100 !== 11 ? 'диалог' : 'диалогов'}
        </Button>
        {selectedIds.length === 0 && (
          <p className="text-center text-xs text-destructive">
            Выберите хотя бы один канал
          </p>
        )}
      </Card>

      {/* ---- Reversible "names glitch" toggle ---- */}
      <Card
        className={cn(
          'flex flex-col gap-4 p-5 transition-colors lg:col-span-2',
          namesHidden ? 'border-destructive/40 bg-destructive/5' : '',
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-xl border',
                namesHidden
                  ? 'border-destructive/30 bg-destructive/10'
                  : 'border-border bg-muted/40',
              )}
            >
              {namesHidden ? (
                <TriangleAlert className="size-5 text-destructive" />
              ) : (
                <Eraser className="size-5 text-foreground" />
              )}
            </div>
            <div>
              <h3 className="font-semibold tracking-tight">Скрыть имена (NULL)</h3>
              <p className="text-sm text-muted-foreground text-pretty">
                Показывает «NULL» вместо имени во всех диалогах — имитация сбоя
                базы. Обратимо: реальные имена сохранены и вернутся при выключении.
              </p>
              <p className="mt-1 text-xs font-medium">
                {namesHidden ? (
                  <span className="text-destructive">
                    Сейчас имена скрыты во всех диалогах
                  </span>
                ) : (
                  <span className="text-muted-foreground">Имена отображаются нормально</span>
                )}
              </p>
            </div>
          </div>
          <Button
            variant={namesHidden ? 'default' : 'outline'}
            className="press-scale shrink-0 gap-2"
            disabled={pending}
            onClick={() => run(() => secretSetNamesHiddenAction(!namesHidden))}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Eraser className="size-4" />
            )}
            {namesHidden ? 'Вернуть имена' : 'Скрыть имена'}
          </Button>
        </div>
      </Card>
    </div>
  )
}

function ToggleTile({
  active,
  onClick,
  title,
  description,
  disabled,
}: {
  active: boolean
  onClick: () => void
  title: string
  description: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'press-scale flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-foreground/20 bg-muted/50'
          : 'border-border bg-transparent hover:bg-muted/30',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors',
          active ? 'border-foreground bg-foreground text-background' : 'border-border',
        )}
      >
        {active && <CheckCircle2 className="size-3.5" />}
      </div>
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground text-pretty">{description}</div>
      </div>
    </button>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
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
            return (
              <div
                key={ch.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                    <ChannelIcon type={ch.type} className="size-4" />
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
