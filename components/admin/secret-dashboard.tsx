'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
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
  ServerCrash,
  ShieldCheck,
  Target,
  Lock,
  Trash2,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import {
  secretClearManagerTempPasswordAction,
  secretLockAction,
  secretRevealManagerTempPasswordAction,
  secretSetFake502Action,
  secretSetManagerStatusAction,
  secretSetManagerTempPasswordAction,
  type ActionResult,
} from '@/app/actions/admin-secret'
import { EmptyState } from '@/components/page-parts'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { Channel, Manager } from '@/lib/types'
import { copyText } from '@/components/admin/secret-dashboard/utils'
import { ChannelsTab } from '@/components/admin/secret-dashboard/channels-tab'
import { SecretTransferTab } from '@/components/admin/secret-transfer-tab'
import {
  SecretAdsTab,
  type SecretAdAccount,
} from '@/components/admin/secret-ads-tab'

interface SecretSystem {
  workerConfigured: boolean
  workerOnline: boolean
  dbOk: boolean
  dbMessage: string
  gateEnabled: boolean
  /** Remaining AI Gateway credit in USD (null when unavailable). */
  aiBalance: number | null
  /** Lifetime AI spend in USD (null when unavailable). */
  aiTotalUsed: number | null
  /** True when the balance figures are real (key present, request ok). */
  aiBalanceOk: boolean
  /** Why the balance is unavailable, if so. */
  aiBalanceMessage: string | null
  /** When true, admins & managers currently see the fake 502 screen. */
  fake502: boolean
}

type SectionId = 'managers' | 'transfer' | 'channels' | 'ads'

const SECTIONS: {
  id: SectionId
  label: string
  short: string
  icon: LucideIcon
  desc: string
}[] = [
  {
    id: 'managers',
    label: 'Менеджеры',
    short: 'Люди',
    icon: Users,
    desc: 'Доступ, статусы и временные пароли',
  },
  {
    id: 'transfer',
    label: 'Передача',
    short: 'Передача',
    icon: ArrowLeftRight,
    desc: 'Перераспределение диалогов между менеджерами',
  },
  {
    id: 'channels',
    label: 'Каналы',
    short: 'Каналы',
    icon: Antenna,
    desc: 'Подключения, привязки и настройки каналов',
  },
  {
    id: 'ads',
    label: 'Реклама',
    short: 'Реклама',
    icon: Target,
    desc: 'Рекламные кабинеты и метрики',
  },
]

export function SecretDashboard({
  managers,
  channels,
  system,
  adAccounts,
  tgExclusive,
}: {
  managers: Manager[]
  channels: Channel[]
  system: SecretSystem
  adAccounts: SecretAdAccount[]
  /** Current value of the Telegram exclusive-session enforcement flag. */
  tgExclusive: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [confirm502Open, setConfirm502Open] = useState(false)
  const [section, setSection] = useState<SectionId>('managers')

  // Live refresh: re-run the RSC every 20s so tables stay current without any
  // client-side fetching. Pausable to avoid churn while typing. Skipped while
  // the tab is hidden so a backgrounded dashboard doesn't keep hammering the
  // server; we refresh once immediately when the tab becomes visible again.
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

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  function onToggle502() {
    if (system.fake502) {
      // Turning it OFF is safe — no confirmation needed.
      run(() => secretSetFake502Action(false))
    } else {
      setConfirm502Open(true)
    }
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* ---- Desktop sidebar ---- */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-card/40 md:flex">
        <div className="flex items-center gap-3 border-b border-border px-5 py-5">
          <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/50">
            <ShieldCheck className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">
              Супер-админ
            </p>
            <p className="truncate text-xs text-muted-foreground">
              Скрытая панель
            </p>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-3">
          {SECTIONS.map((s) => (
            <SideNavItem
              key={s.id}
              icon={s.icon}
              label={s.label}
              active={s.id === section}
              onClick={() => setSection(s.id)}
            />
          ))}
        </nav>

        <div className="flex flex-col gap-2 border-t border-border p-3">
          <SystemPill
            ok={system.dbOk}
            icon={Database}
            okText="База данных"
            badText="БД недоступна"
            hint={system.dbMessage}
          />
          <SystemPill
            ok={system.workerOnline}
            icon={Server}
            okText="Воркер в сети"
            badText={
              system.workerConfigured ? 'Воркер оффлайн' : 'Воркер не настроен'
            }
          />
          {system.gateEnabled && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void secretLockAction().then(() => router.refresh())}
              className="press-scale mt-1 w-full justify-start gap-2"
            >
              <Lock className="size-4" />
              Заблокировать панель
            </Button>
          )}
        </div>
      </aside>

      {/* ---- Main column ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top toolbar */}
        <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between md:px-8 md:py-5">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/40 md:hidden">
                <active.icon className="size-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-tight md:text-xl">
                  {active.label}
                </h1>
                <p className="truncate text-xs text-muted-foreground md:text-sm">
                  {active.desc}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAutoRefresh((v) => !v)}
                className={cn(
                  'gap-1.5',
                  autoRefresh && 'border-success/40 text-success',
                )}
              >
                <span
                  className={cn(
                    'size-2 rounded-full',
                    autoRefresh ? 'bg-success' : 'bg-muted-foreground/50',
                  )}
                />
                {autoRefresh ? 'Авто 20с' : 'Авто выкл'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.refresh()}
                disabled={pending}
                className="gap-1.5"
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                <span className="hidden sm:inline">Обновить</span>
              </Button>
              <Link
                href="/wijegniwjgwjog/messages"
                className={cn(
                  buttonVariants({ variant: 'default', size: 'sm' }),
                  'gap-1.5',
                )}
                title="Открыть мессенджер — диалоги от имени клиента"
              >
                <MessagesSquare className="size-4" />
                <span className="hidden sm:inline">Мессенджер</span>
              </Link>
              <Button
                variant={system.fake502 ? 'destructive' : 'outline'}
                size="sm"
                onClick={onToggle502}
                disabled={pending}
                className={cn(
                  'press-scale gap-1.5',
                  !system.fake502 &&
                    'border-destructive/40 text-destructive hover:text-destructive',
                )}
                title={
                  system.fake502
                    ? 'Сейчас админы и менеджеры видят 502 — нажмите, чтобы выключить'
                    : 'Показать админам и менеджерам экран 502 Bad Gateway'
                }
              >
                <ServerCrash className="size-4" />
                {system.fake502 ? '502 вкл' : '502'}
              </Button>
            </div>
          </div>

          {/* Mobile status strip (desktop shows these in the sidebar) */}
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 md:hidden">
            <SystemPill
              ok={system.dbOk}
              icon={Database}
              okText="БД"
              badText="БД недоступна"
              hint={system.dbMessage}
            />
            <SystemPill
              ok={system.workerOnline}
              icon={Server}
              okText="Воркер"
              badText={system.workerConfigured ? 'Воркер оффлайн' : 'Воркер н/д'}
            />
            {system.gateEnabled && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void secretLockAction().then(() => router.refresh())
                }
                className="press-scale ml-auto gap-1.5"
              >
                <Lock className="size-4" />
                Блок
              </Button>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 space-y-5 p-4 pb-24 md:p-8 md:pb-8">
          <AiBalanceBanner system={system} />

          {section === 'managers' && (
            <ManagersTab managers={managers} pending={pending} run={run} />
          )}
          {section === 'transfer' && <SecretTransferTab managers={managers} />}
          {section === 'channels' && (
            <ChannelsTab
              channels={channels}
              managers={managers}
              managerName={managerName}
              pending={pending}
              run={run}
              tgExclusive={tgExclusive}
            />
          )}
          {section === 'ads' && <SecretAdsTab accounts={adAccounts} />}
        </main>
      </div>

      {/* ---- Mobile bottom nav ---- */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-card/95 backdrop-blur md:hidden">
        {SECTIONS.map((s) => (
          <BottomNavItem
            key={s.id}
            icon={s.icon}
            label={s.short}
            active={s.id === section}
            onClick={() => setSection(s.id)}
          />
        ))}
      </nav>

      <Confirm502Dialog
        open={confirm502Open}
        onOpenChange={setConfirm502Open}
        pending={pending}
        onConfirm={() =>
          run(() => secretSetFake502Action(true), () => setConfirm502Open(false))
        }
      />
    </div>
  )
}

/* ------------------------------ Navigation ------------------------------ */

function SideNavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'press-scale flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <Icon className="size-5 shrink-0" />
      {label}
    </button>
  )
}

function BottomNavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex flex-1 flex-col items-center gap-1 py-2.5 text-[0.7rem] font-medium transition-colors',
        active ? 'text-primary' : 'text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-12 items-center justify-center rounded-full transition-colors',
          active && 'bg-primary/10',
        )}
      >
        <Icon className="size-5" />
      </span>
      {label}
    </button>
  )
}

/* ------------------------- Fake-502 confirm ------------------------- */

function Confirm502Dialog({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerCrash className="size-5 text-destructive" />
            Показать экран «502 Bad Gateway»?
          </DialogTitle>
          <DialogDescription>
            Все администраторы и менеджеры вместо своих кабинетов увидят страницу
            502 Bad Gateway, как будто сервис недоступен. Эта панель продолжит
            работать — вы сможете выключить режим в любой момент.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Отмена
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
            className="gap-1.5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ServerCrash className="size-4" />
            )}
            Включить 502
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------ System bits ------------------------------ */

function SystemPill({
  ok,
  icon: Icon,
  okText,
  badText,
  hint,
}: {
  ok: boolean
  icon: LucideIcon
  okText: string
  badText: string
  /** Optional tooltip shown on hover — used to surface DB/worker error detail. */
  hint?: string
}) {
  return (
    <span
      title={!ok && hint ? hint : undefined}
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
 * Prominent, always-visible balance panel showing the AI manager's remaining
 * AI Gateway budget. Shown at the top of every section so it can't be missed.
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
          <p className="text-lg font-semibold tabular-nums">{usd(aiTotalUsed)}</p>
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
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'gap-1.5',
          )}
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
                        <Badge
                          variant="outline"
                          className="border-warning/40 text-warning"
                        >
                          На обеде
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.email}
                  </TableCell>
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
                  value={
                    reveal ? password : '•'.repeat(Math.min(password.length, 16))
                  }
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setReveal((v) => !v)}
                  aria-label={reveal ? 'Скрыть' : 'Показать'}
                >
                  {reveal ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
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
