'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Activity,
  Antenna,
  ArrowLeftRight,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Copy,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Target,
  Lock,
  Trash2,
  Users,
  Wallet,
  Zap,
} from 'lucide-react'
import {
  secretClearManagerTempPasswordAction,
  secretLockAction,
  secretRevealManagerTempPasswordAction,
  secretSetManagerStatusAction,
  secretSetManagerTempPasswordAction,
  type ActionResult,
} from '@/app/actions/admin-secret'
import { StatCard, EmptyState } from '@/components/page-parts'
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
import {
  convStatusLabel,
  copyText,
  CONV_STATUS_STYLE,
} from '@/components/admin/secret-dashboard/utils'
import { ChannelsTab } from '@/components/admin/secret-dashboard/channels-tab'
import { MassImportTab } from '@/components/admin/secret-dashboard/mass-import-tab'
// Recharts is heavy; keep it out of the initial secret-dashboard bundle and
// load each chart lazily when the dashboard renders. ssr:false because the
// charts measure their container and produce no useful server HTML.
const MessagesTrendChart = dynamic(
  () =>
    import('@/components/admin/secret-charts').then(
      (m) => m.MessagesTrendChart,
    ),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse rounded-lg bg-muted/40" />,
  },
)
const ChannelsTypeChart = dynamic(
  () =>
    import('@/components/admin/secret-charts').then((m) => m.ChannelsTypeChart),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse rounded-lg bg-muted/40" />,
  },
)
// The console is large, rarely the first tab an admin opens, and pulls its own
// tree of sub-components. Radix TabsContent doesn't mount inactive tabs, so
// loading it lazily means its JS only downloads when the admin actually
// switches to that tab. ssr:false since it's interactive-only.
const SecretConsole = dynamic(
  () =>
    import('@/components/admin/secret-console').then((m) => m.SecretConsole),
  {
    ssr: false,
    loading: () => (
      <div className="h-96 animate-pulse rounded-lg bg-muted/40" />
    ),
  },
)
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


export function SecretDashboard({
  managers,
  channels,
  stats,
  system,
  namesHidden,
  adAccounts,
  tgExclusive,
}: {
  managers: Manager[]
  channels: Channel[]
  stats: SecretStats
  system: SecretSystem
  namesHidden: boolean
  adAccounts: SecretAdAccount[]
  /** Current value of the Telegram exclusive-session enforcement flag. */
  tgExclusive: boolean
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
            tgExclusive={tgExclusive}
          />
        </TabsContent>
        <TabsContent value="ads" className="mt-4">
          <SecretAdsTab accounts={adAccounts} />
        </TabsContent>
        <TabsContent value="console" className="mt-4">
          <SecretConsole channels={channels} managers={managers} />
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
 * Live AI Gateway balance pill — the manager brain's remaining AI budget on the
 * shared key. Turns amber when funds run low and red when unavailable/empty.
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
          ? `Остаток на ИИ. Потрачено всего: ${usd(aiTotalUsed)}`
          : 'Остаток на ИИ'
      }
    >
      <Wallet className="size-3.5" />
      Баланс ИИ: {usd(aiBalance)}
    </span>
  )
}

/**
 * Prominent, always-visible balance panel showing the AI manager's remaining
 * AI Gateway budget. Shown right under the header so it can't be missed on
 * mobile.
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
            Баланс ИИ (менеджер)
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
                      <ManagerTempPassword manager={m} />
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

/* -------------------------- Temp password ----------------------------- */

/**
 * Per-manager temporary-password control. Opens a dialog that reveals the
 * current temp password (fetched on demand, decrypted server-side), and lets an
 * admin generate a new one, set a custom one, or clear it. This is a SEPARATE
 * credential from the manager's real password (which is a one-way bcrypt hash
 * and can never be shown) — see scripts/079_manager_temp_password.sql.
 */
function ManagerTempPassword({ manager }: { manager: Manager }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState<string | null>(null)
  const [setAt, setSetAt] = useState<string | null>(null)
  const [reveal, setReveal] = useState(false)
  const [custom, setCustom] = useState('')

  async function load() {
    setLoading(true)
    try {
      const res = await secretRevealManagerTempPasswordAction(manager.id)
      if (res.ok) {
        setPassword(res.password ?? null)
        setSetAt(res.setAt ?? null)
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('Не удалось загрузить пароль')
    } finally {
      setLoading(false)
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setReveal(false)
      setCustom('')
      void load()
    }
  }

  function handleSet(customValue?: string) {
    setBusy(true)
    ;(async () => {
      try {
        const res = await secretSetManagerTempPasswordAction({
          managerId: manager.id,
          password: customValue,
        })
        if (res.ok) {
          setPassword(res.password ?? null)
          setSetAt(res.setAt ?? null)
          setReveal(true)
          setCustom('')
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось сохранить пароль')
      } finally {
        setBusy(false)
      }
    })()
  }

  function handleClear() {
    setBusy(true)
    ;(async () => {
      try {
        const res = await secretClearManagerTempPasswordAction(manager.id)
        if (res.ok) {
          setPassword(null)
          setSetAt(null)
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось удалить пароль')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => onOpenChange(true)}
      >
        <KeyRound className="size-3.5" />
        Пароль
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Временный пароль</DialogTitle>
          <DialogDescription>
            {manager.name} — дополнительный пароль для входа, не связанный с
            основным. Основной пароль хранится в виде необратимого хеша и не может
            быть показан.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Текущий временный пароль</Label>
            {loading ? (
              <div className="flex h-10 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Загрузка…
              </div>
            ) : password ? (
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={reveal ? password : '•'.repeat(Math.min(password.length, 16))}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setReveal((v) => !v)}
                  aria-label={reveal ? 'Скрыть' : 'Показать'}
                >
                  {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => copyText(password)}
                  aria-label="Скопировать"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                Временный пароль не задан.
              </p>
            )}
            {setAt ? (
              <p className="text-xs text-muted-foreground">
                Установлен: {new Date(setAt).toLocaleString('ru-RU')}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`custom-${manager.id}`}>Задать свой пароль</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`custom-${manager.id}`}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Минимум 6 символов"
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || custom.trim().length < 6}
                onClick={() => handleSet(custom.trim())}
              >
                Сохранить
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="outline"
            className="gap-1.5 text-destructive"
            disabled={busy || !password}
            onClick={handleClear}
          >
            <Trash2 className="size-4" />
            Удалить
          </Button>
          <Button
            type="button"
            className="gap-1.5"
            disabled={busy}
            onClick={() => handleSet(undefined)}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Сгенерировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

