'use client'

import Link from 'next/link'
import { useMemo, useRef, useState, useTransition } from 'react'
import {
  Loader2,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { channelIcon } from '@/components/channel-icons'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  adminConnectMaxAction,
  adminConnectTelegramAction,
  adminConnectVkAction,
  adminDeleteChannelAction,
  adminGetChannelStatusAction,
  adminHealthCheckAction,
  adminReassignProxyAction,
  adminSubmitTelegramCodeAction,
  adminSubmitTelegramPasswordAction,
} from '@/app/actions/admin-accounts'
import { StatusBadge } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
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
import { getChannelMeta, type Manager, type Proxy } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { AdminChannel } from '@/lib/data'

type CreatableType = 'telegram' | 'vk' | 'max'

const TYPE_ICON = {
  telegram: channelIcon('telegram'),
  whatsapp: channelIcon('whatsapp'),
  vk: channelIcon('vk'),
  max: channelIcon('max'),
} as const

const SESSION_LABEL: Record<string, string> = {
  idle: 'Ожидание',
  starting: 'Запуск…',
  qr_pending: 'Ждёт QR',
  code_pending: 'Ждёт код',
  password_pending: 'Ждёт пароль',
  online: 'В сети',
  offline: 'Не в сети',
  error: 'Ошибка',
  logged_out: 'Вышел из аккаунта',
  rate_limited: 'Ограничен',
}

function proxyLabelText(p: Proxy): string {
  return `${p.label} · ${p.kind} · ${p.host}:${p.port}`
}

/**
 * Whether a proxy can serve an account of `type`:
 *  - MTProto proxies are Telegram-only (they can't tunnel VK/MAX/WhatsApp HTTP).
 *  - The proxy must not already be bound to another account of the same type.
 */
function proxyEligible(
  p: Proxy,
  type: CreatableType,
  usage: Record<string, string[]>,
): boolean {
  if (p.kind === 'mtproto' && type !== 'telegram') return false
  const used = usage[p.id] ?? []
  return !used.includes(type)
}

export function AccountsAdmin({
  channels,
  proxies,
  managers,
  proxyUsage,
  workerOnline,
  only,
}: {
  channels: AdminChannel[]
  proxies: Proxy[]
  managers: Manager[]
  proxyUsage: Record<string, string[]>
  workerOnline: boolean
  /** Restrict the create form and table to a single source type. */
  only?: CreatableType
}) {
  const visibleChannels = only
    ? channels.filter((c) => c.type === only)
    : channels
  return (
    <div className="flex flex-col gap-6">
      <CreateAccountCard
        proxies={proxies}
        managers={managers}
        proxyUsage={proxyUsage}
        workerOnline={workerOnline}
        only={only}
      />
      <AccountsTable
        channels={visibleChannels}
        proxies={proxies}
        proxyUsage={proxyUsage}
      />
    </div>
  )
}

/* ------------------------------ Create card ------------------------------ */

function CreateAccountCard({
  proxies,
  managers,
  proxyUsage,
  workerOnline,
  only,
}: {
  proxies: Proxy[]
  managers: Manager[]
  proxyUsage: Record<string, string[]>
  workerOnline: boolean
  only?: CreatableType
}) {
  const [type, setType] = useState<CreatableType>(only ?? 'telegram')
  const [managerId, setManagerId] = useState('')
  const [proxyId, setProxyId] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [token, setToken] = useState('')
  const [pending, startTransition] = useTransition()

  // Telegram multi-step login state.
  const [tgChannelId, setTgChannelId] = useState<string | null>(null)
  const [tgStep, setTgStep] = useState<'code' | 'password' | null>(null)
  const [tgCode, setTgCode] = useState('')
  const [tgPassword, setTgPassword] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Wall-clock deadline for the login to leave the 'starting' state. If the
  // worker is offline or the job is never claimed, the session status stays
  // 'starting' forever and the code window never appears — so we stop polling
  // and surface a clear error instead of spinning indefinitely.
  const pollDeadlineRef = useRef<number>(0)

  const eligibleProxies = useMemo(
    () => proxies.filter((p) => proxyEligible(p, type, proxyUsage)),
    [proxies, type, proxyUsage],
  )

  function resetForm() {
    setName('')
    setPhone('')
    setToken('')
    setProxyId('')
    setManagerId('')
    setTgChannelId(null)
    setTgStep(null)
    setTgCode('')
    setTgPassword('')
    if (pollRef.current) clearInterval(pollRef.current)
  }

  function validateCommon(): string | null {
    if (!managerId) return 'Выберите менеджера-владельца.'
    // Proxy is optional — an empty proxyId means a direct connection.
    return null
  }

  function pollTelegram(channelId: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    // Allow up to 90s to reach a code/password/online/error state. Requesting
    // the code from Telegram (through the account's proxy) can take a while, but
    // if nothing happens by then the worker is almost certainly not processing
    // the job — tell the admin instead of leaving them staring at a spinner.
    pollDeadlineRef.current = Date.now() + 90_000
    pollRef.current = setInterval(async () => {
      const snap = await adminGetChannelStatusAction(channelId)
      if (!snap) return
      if (snap.sessionStatus === 'code_pending') {
        setTgStep('code')
      } else if (snap.sessionStatus === 'password_pending') {
        setTgStep('password')
      } else if (snap.sessionStatus === 'online') {
        if (pollRef.current) clearInterval(pollRef.current)
        toast.success('Telegram-аккаунт подключён.')
        resetForm()
      } else if (
        snap.sessionStatus === 'error' ||
        snap.sessionStatus === 'logged_out'
      ) {
        if (pollRef.current) clearInterval(pollRef.current)
        toast.error(snap.lastError || 'Не удалось подключить Telegram.')
      } else if (
        // Still 'starting'/'idle' past the deadline → the worker never picked
        // up the job. Stop and explain, so the flow doesn't hang forever.
        Date.now() > pollDeadlineRef.current &&
        (snap.sessionStatus === 'starting' || snap.sessionStatus === 'idle')
      ) {
        if (pollRef.current) clearInterval(pollRef.current)
        toast.error(
          'Telegram не ответил. Убедитесь, что процесс воркера запущен на VPS и подключён к базе, затем попробуйте снова.',
        )
      }
    }, 2000)
  }

  function submitCreate() {
    const err = validateCommon()
    if (err) {
      toast.error(err)
      return
    }
    const fd = new FormData()
    fd.set('managerId', managerId)
    fd.set('proxyId', proxyId)
    fd.set('name', name)

    startTransition(async () => {
      if (type === 'telegram') {
        if (!phone.trim()) {
          toast.error('Введите номер телефона.')
          return
        }
        // Telegram login is driven entirely by the worker (MTProto). If it's
        // offline the job will queue but never run, so the code window would
        // never appear. Block up-front with a clear reason instead.
        if (!workerOnline) {
          toast.error(
            'Воркер не в сети. Telegram-вход требует запущенного процесса воркера на VPS — запустите его и повторите.',
          )
          return
        }
        fd.set('phone', phone)
        const res = await adminConnectTelegramAction(fd)
        if (!res.ok) {
          toast.error(res.message)
          return
        }
        toast.message(res.message)
        if (res.channelId) {
          setTgChannelId(res.channelId)
          pollTelegram(res.channelId)
        }
      } else if (type === 'vk') {
        if (!token.trim()) {
          toast.error('Вставьте токен сообщества VK.')
          return
        }
        fd.set('token', token)
        const res = await adminConnectVkAction(fd)
        if (!res.ok) {
          toast.error(res.message)
          return
        }
        toast.success(res.message)
        resetForm()
      } else {
        if (!token.trim()) {
          toast.error('Вставьте токен бота MAX.')
          return
        }
        fd.set('token', token)
        const res = await adminConnectMaxAction(fd)
        if (!res.ok) {
          toast.error(res.message)
          return
        }
        toast.success(res.message)
        resetForm()
      }
    })
  }

  function submitCode() {
    if (!tgChannelId || !tgCode.trim()) return
    startTransition(async () => {
      const res = await adminSubmitTelegramCodeAction(tgChannelId, tgCode)
      if (!res.ok) toast.error(res.message)
      else {
        toast.message(res.message)
        setTgCode('')
      }
    })
  }

  function submitPassword() {
    if (!tgChannelId || !tgPassword.trim()) return
    startTransition(async () => {
      const res = await adminSubmitTelegramPasswordAction(
        tgChannelId,
        tgPassword,
      )
      if (!res.ok) toast.error(res.message)
      else {
        toast.message(res.message)
        setTgPassword('')
      }
    })
  }

  const TYPES: { value: CreatableType; label: string }[] = [
    { value: 'telegram', label: 'Telegram' },
    { value: 'vk', label: 'VK' },
    { value: 'max', label: 'MAX' },
  ]

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Plus className="size-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">Подключить аккаунт</h2>
          <p className="text-xs text-muted-foreground">
            Создание аккаунтов доступно только администратору. Прокси
            необязателен — без него подключение идёт напрямую.
          </p>
        </div>
      </div>

      {/* Type selector — hidden when the card is scoped to one source. */}
      {!only ? (
        <div className="mb-4 grid grid-cols-3 gap-2">
          {TYPES.map((t) => {
            const Icon = TYPE_ICON[t.value]
            const active = type === t.value
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => {
                  setType(t.value)
                  setProxyId('')
                }}
                disabled={pending || Boolean(tgChannelId)}
                className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'border-foreground bg-secondary text-secondary-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted/50'
                }`}
              >
                <Icon className="size-4" />
                {t.label}
              </button>
            )
          })}
        </div>
      ) : null}

      {!only ? (
        <p className="mb-4 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          WhatsApp подключается на странице{' '}
          <Link href="/admin/whatsapp" className="font-medium text-foreground underline">
            WhatsApp
          </Link>
          , после чего назначьте номеру прокси в таблице ниже.
        </p>
      ) : null}

      {/* Common fields. Wrapped in a <form> so browsers can associate the
          password inputs (MAX/VK token, TG 2FA) with a form for autofill and
          to silence "Password field is not contained in a form". */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!pending && !(type === 'telegram' && !workerOnline)) {
            void submitCreate()
          }
        }}
      >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>Менеджер-владелец</Label>
          <Select
            value={managerId}
            onValueChange={(v) => setManagerId(v ?? '')}
          >
            <SelectTrigger>
              <SelectValue placeholder="Выберите менеджера" />
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

        <div className="flex flex-col gap-1.5">
          <Label>Прокси (необязательно)</Label>
          <Select
            value={proxyId || 'none'}
            onValueChange={(v) => setProxyId(v === 'none' ? '' : (v ?? ''))}
          >
            <SelectTrigger className="min-w-0">
              <SelectValue placeholder="Без прокси — прямое подключение">
                {(value: string | null) =>
                  !value || value === 'none'
                    ? 'Без прокси — прямое подключение'
                    : (eligibleProxies.find((p) => p.id === value)
                        ? proxyLabelText(
                            eligibleProxies.find((p) => p.id === value)!,
                          )
                        : 'Прокси выбран')
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                Без прокси — прямое подключение
              </SelectItem>
              {eligibleProxies.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {proxyLabelText(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Прокси не обязателен. Если аккаунт не подключается через прокси
            (например, прокси не пропускает Telegram), выберите «Без прокси» —
            подключение пойдёт напрямую.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Название {type === 'telegram' ? '' : '(необязательно)'}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, «Продажи»"
            disabled={Boolean(tgChannelId)}
          />
        </div>

        {type === 'telegram' ? (
          <div className="flex flex-col gap-1.5">
            <Label>Номер телефона</Label>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+14155550132"
              disabled={Boolean(tgChannelId)}
            />
            {!workerOnline ? (
              <p className="text-xs text-warning">
                Воркер не в сети — вход в Telegram сейчас недоступен. Запустите
                процесс воркера на VPS, чтобы получить код подтверждения.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                После нажатия «Подключить» откроется окно для ввода кода из
                Telegram.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label>
              {type === 'vk' ? 'Токен сообщества VK' : 'Токен бота MAX'}
            </Label>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                type === 'vk'
                  ? 'vk1.a.xxxxxxxx (scope: messages + manage)'
                  : 'Токен из @MasterBot'
              }
              type="password"
            />
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          type="submit"
          disabled={pending || (type === 'telegram' && !workerOnline)}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Подключить
        </Button>
      </div>
      </form>

      {/*
        Telegram login modal. It opens automatically as soon as the connect flow
        starts (tgChannelId is set) so the code / 2FA-password entry is
        impossible to miss — previously these steps rendered as a small inline
        box at the bottom of the card that was easy to overlook.
      */}
      <Dialog
        open={Boolean(tgChannelId)}
        onOpenChange={(o) => {
          if (!o) resetForm()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Подключение Telegram</DialogTitle>
            <DialogDescription>
              {phone ? `Номер ${phone}` : 'Вход в аккаунт Telegram'}
            </DialogDescription>
          </DialogHeader>

          {tgStep === 'code' ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (!pending && tgCode.trim()) submitCode()
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label>Код из Telegram</Label>
                <Input
                  value={tgCode}
                  onChange={(e) => setTgCode(e.target.value)}
                  placeholder="12345"
                  inputMode="numeric"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      submitCode()
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Введите код, который пришёл в приложение Telegram или по SMS.
                </p>
              </div>
              <Button
                type="submit"
                disabled={pending || !tgCode.trim()}
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Отправить код
              </Button>
            </form>
          ) : tgStep === 'password' ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (!pending && tgPassword.trim()) submitPassword()
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label>Пароль двухэтапной аутентификации</Label>
                <Input
                  value={tgPassword}
                  onChange={(e) => setTgPassword(e.target.value)}
                  type="password"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      submitPassword()
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  На аккаунте включена двухэтапная аутентификация — введите
                  облачный пароль Telegram.
                </p>
              </div>
              <Button
                type="submit"
                disabled={pending || !tgPassword.trim()}
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Отправить пароль
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              Запрашиваем код у Telegram… Это может занять несколько секунд.
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={resetForm} disabled={pending}>
              Отменить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/* ----------------------------- Accounts table ---------------------------- */

export function AccountsTable({
  channels,
  proxies,
  proxyUsage,
}: {
  channels: AdminChannel[]
  proxies: Proxy[]
  proxyUsage: Record<string, string[]>
}) {
  if (channels.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Server className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm font-medium">Пока нет подключённых аккаунтов</p>
        <p className="text-xs text-muted-foreground">
          Подключите первый аккаунт в форме выше.
        </p>
      </Card>
    )
  }

  return (
    <Card className="divide-y divide-border">
      {channels.map((c) => (
        <AccountRow
          key={c.id}
          channel={c}
          proxies={proxies}
          proxyUsage={proxyUsage}
        />
      ))}
    </Card>
  )
}

function AccountRow({
  channel,
  proxies,
  proxyUsage,
}: {
  channel: AdminChannel
  proxies: Proxy[]
  proxyUsage: Record<string, string[]>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [checking, setChecking] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const Icon = TYPE_ICON[channel.type as keyof typeof TYPE_ICON] ?? Server

  function healthCheck() {
    setChecking(true)
    startTransition(async () => {
      const res = await adminHealthCheckAction(channel.id)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
      setChecking(false)
      router.refresh()
    })
  }

  // Proxies eligible to (re)assign to THIS account: right kind + not used by
  // another account of the same type (the account's current proxy is allowed).
  const eligible = useMemo(
    () =>
      proxies.filter((p) => {
        if (p.id === channel.proxyId) return true
        if (p.kind === 'mtproto' && channel.type !== 'telegram') return false
        const used = proxyUsage[p.id] ?? []
        return !used.includes(channel.type)
      }),
    [proxies, proxyUsage, channel.proxyId, channel.type],
  )

  // base-ui's <Select.Value> renders the raw value string unless we format it,
  // which is why the trigger showed a bare proxy UUID. Map id → readable label.
  const proxyLabelById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of proxies) m.set(p.id, proxyLabelText(p))
    return m
  }, [proxies])

  function reassign(proxyId: string) {
    // 'none' sentinel → detach the proxy (direct connection).
    const next = proxyId === 'none' ? null : proxyId
    startTransition(async () => {
      const res = await adminReassignProxyAction(channel.id, next)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  function remove() {
    startTransition(async () => {
      try {
        const res = await adminDeleteChannelAction(channel.id)
        if (res.ok) {
          toast.success(res.message)
          router.refresh()
        } else {
          toast.error(res.message)
        }
      } catch (err) {
        // A thrown server action (e.g. network/DB error) would otherwise leave
        // the dialog stuck with no feedback — surface it explicitly instead.
        console.error('[v0] delete channel failed:', err)
        toast.error('Не удалось удалить аккаунт. Попробуйте ещё раз.')
      } finally {
        setConfirmOpen(false)
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{channel.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {getChannelMeta(channel.type).label} · {channel.detail} ·{' '}
            {channel.managerName || 'Без менеджера'}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
          {SESSION_LABEL[channel.sessionStatus] ?? channel.sessionStatus}
        </span>
        <StatusBadge status={channel.status} />
      </div>

      <div className="flex min-w-0 items-center gap-2 sm:w-72">
        {channel.proxyId ? null : (
          <ShieldAlert className="size-4 shrink-0 text-warning" />
        )}
        <Select
          value={channel.proxyId ?? 'none'}
          onValueChange={(v) => v && reassign(v)}
          disabled={pending}
        >
          <SelectTrigger className="h-9 min-w-0 flex-1">
            <SelectValue placeholder="Без прокси — напрямую">
              {(value: string | null) =>
                !value || value === 'none'
                  ? 'Без прокси — напрямую'
                  : (proxyLabelById.get(value) ?? 'Прокси назначен')
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Без прокси — напрямую</SelectItem>
            {eligible.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {proxyLabelText(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="icon-sm"
          onClick={healthCheck}
          disabled={pending}
          aria-label="Проверить связь / переподключить"
          title="Проверить связь"
          className="shrink-0"
        >
          <RefreshCw className={cn('size-4', checking && 'animate-spin')} />
        </Button>

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => setConfirmOpen(true)}
          disabled={pending}
          aria-label="Удалить аккаунт"
          title="Удалить аккаунт"
          className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить аккаунт?</DialogTitle>
            <DialogDescription>
              «{channel.name}» будет отключён, а его вебхук/сессия — остановлены.
              Историю переписок это не удаляет.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={pending}
            >
              Отмена
            </Button>
            <Button variant="destructive" onClick={remove} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Удалить
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
