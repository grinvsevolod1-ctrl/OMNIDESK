'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  connectMaxAction,
  connectTelegramAction,
  connectVkAction,
  getChannelStatusAction,
  submitTelegramCodeAction,
  submitTelegramPasswordAction,
} from '@/app/actions/channels'
import { Button } from '@/components/ui/button'
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
import type { ChannelType, Proxy, SessionStatus } from '@/lib/types'

type Step =
  | 'pick'
  | 'tg-phone'
  | 'tg-code'
  | 'tg-password'
  | 'max-token'
  | 'vk-token'
  | 'connected'

const OPTIONS: {
  type: Extract<ChannelType, 'telegram' | 'max' | 'vk'>
  label: string
  description: string
  icon: typeof Send
}[] = [
  {
    type: 'telegram',
    label: 'Telegram',
    description: 'Личный аккаунт по номеру телефона (MTProto)',
    icon: Send,
  },
  {
    type: 'max',
    label: 'MAX',
    description: 'Бот MAX по токену из @MasterBot (Bot API)',
    icon: MessageSquare,
  },
  {
    type: 'vk',
    label: 'VK',
    description: 'Сообщество VK по ключу доступа (Callback API)',
    icon: Users,
  },
]

export function ConnectWizard({
  label = 'Добавить подключение',
  variant = 'default',
  proxies,
}: {
  label?: string
  variant?: 'default' | 'outline' | 'ghost'
  proxies: Proxy[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('pick')
  const [pending, startTransition] = useTransition()

  const [channelId, setChannelId] = useState<string | null>(null)
  const [proxyId, setProxyId] = useState<string>('none')
  const [code, setCode] = useState('')
  // Where Telegram actually sent the login code (in-app message vs SMS), so the
  // code step can point the manager to the right place.
  const [codeDelivery, setCodeDelivery] = useState<'app' | 'sms' | null>(null)
  const [password, setPassword] = useState('')
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  // Live QR data-URL when the worker falls back to QR (no phone / fallback).
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Wall-clock start of the current polling run; backs the client-side timeout
  // that stops the loader if the worker never produces a terminal state (e.g.
  // worker down, dead proxy). Kept slightly above the worker's own timeout.
  const pollStartRef = useRef<number>(0)
  // Which channel type the current flow is for. Only Telegram has a live login
  // flow now (WhatsApp is admin-managed; MAX is a one-shot webhook setup).
  const activeType = useRef<'telegram' | null>(null)
  // Tracks whether we created/changed anything that the connections list should
  // pick up. We refresh ONCE on close to avoid unmounting the dialog mid-flow.
  const dirtyRef = useRef(false)

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  function reset() {
    stopPolling()
    setStep('pick')
    setChannelId(null)
    setProxyId('none')
    setCode('')
    setCodeDelivery(null)
    setPassword('')
    setPairingCode(null)
    setQr(null)
    setError(null)
  }

  // Close the dialog and, only afterwards, refresh the route so the new channel
  // shows up. Refreshing while open could swap the empty-state for the grid and
  // unmount this very dialog.
  function close() {
    setOpen(false)
    const needsRefresh = dirtyRef.current
    dirtyRef.current = false
    setTimeout(() => {
      reset()
      if (needsRefresh) router.refresh()
    }, 150)
  }

  useEffect(() => () => stopPolling(), [])

  // React to a session status reported by polling. Only ever moves the flow
  // FORWARD — it never resets back to an earlier step.
  function applyStatus(status: SessionStatus, lastError: string | null) {
    setError(lastError)
    if (status === 'code_pending' || status === 'qr_pending') {
      // Only Telegram polls now (WhatsApp Cloud has no live session).
      setStep('tg-code')
    } else if (status === 'password_pending') setStep('tg-password')
    else if (status === 'online') {
      stopPolling()
      dirtyRef.current = true
      setStep('connected')
    } else if (
      status === 'error' ||
      status === 'logged_out' ||
      status === 'rate_limited'
    ) {
      // Terminal failure: stop polling so the loader doesn't spin forever, and
      // surface a message (fall back to a generic one if the worker gave none).
      stopPolling()
      if (!lastError) {
        setError(
          status === 'logged_out'
            ? 'Этот аккаунт вышел из системы. Начните заново, чтобы привязать его повторно.'
            : status === 'rate_limited'
              ? 'Привязка приостановлена для защиты аккаунта от блокировки. Подождите немного и попробуйте снова.'
              : 'Не удалось выполнить привязку. Попробуйте ещё раз.',
        )
      }
    }
  }

  // Poll channel status while a Telegram login flow is running. (WhatsApp Cloud
  // and MAX are webhook-based and never poll.)
  function startPolling(id: string) {
    stopPolling()
    pollStartRef.current = Date.now()
    pollRef.current = setInterval(async () => {
      const snap = await getChannelStatusAction(id)
      if (!snap) return
      if (snap.codeDelivery) setCodeDelivery(snap.codeDelivery)
      applyStatus(snap.sessionStatus, snap.lastError)
    }, 2000)
  }

  function pick(t: ChannelType) {
    setError(null)
    if (t === 'telegram') {
      activeType.current = 'telegram'
      setStep('tg-phone')
    } else if (t === 'max') {
      setStep('max-token')
    } else if (t === 'vk') {
      setStep('vk-token')
    }
  }

  /* ----------------------------- Telegram ----------------------------- */

  function submitPhone(formData: FormData) {
    if (proxyId !== 'none') formData.set('proxyId', proxyId)
    startTransition(async () => {
      const res = await connectTelegramAction(formData)
      if (!res.ok || !res.channelId) {
        setError(res.message)
        toast.error(res.message)
        return
      }
      dirtyRef.current = true
      setChannelId(res.channelId)
      setStep('tg-code')
      startPolling(res.channelId)
    })
  }

  function submitCode() {
    if (!channelId || !code.trim()) return
    startTransition(async () => {
      const res = await submitTelegramCodeAction(channelId, code)
      if (!res.ok) {
        setError(res.message)
        return
      }
      startPolling(channelId)
    })
  }

  function submitPassword() {
    if (!channelId || !password) return
    startTransition(async () => {
      const res = await submitTelegramPasswordAction(channelId, password)
      if (!res.ok) {
        setError(res.message)
        return
      }
      startPolling(channelId)
    })
  }

  /* ------------------------------- MAX -------------------------------- */

  // MAX is a Bot API integration: one round-trip (validate token + register
  // webhook) and we're done — no polling, no live session.
  function submitMaxToken(formData: FormData) {
    startTransition(async () => {
      const res = await connectMaxAction(formData)
      if (!res.ok) {
        setError(res.message)
        toast.error(res.message)
        return
      }
      dirtyRef.current = true
      setChannelId(res.channelId ?? null)
      toast.success(res.message)
      setStep('connected')
    })
  }

  /* -------------------------------- VK -------------------------------- */

  // VK is a Callback API integration: one round-trip (validate token, fetch the
  // confirmation code, register the callback server + subscribe to message_new)
  // and we're done — no polling, no live session.
  function submitVkToken(formData: FormData) {
    startTransition(async () => {
      const res = await connectVkAction(formData)
      if (!res.ok) {
        setError(res.message)
        toast.error(res.message)
        return
      }
      dirtyRef.current = true
      setChannelId(res.channelId ?? null)
      toast.success(res.message)
      setStep('connected')
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setOpen(true)
        else close()
      }}
    >
      <DialogTrigger
        render={
          <Button variant={variant}>
            <Plus className="size-4" />
            {label}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        {/* PICK */}
        {step === 'pick' ? (
          <>
            <DialogHeader>
              <DialogTitle>Добавить подключение</DialogTitle>
              <DialogDescription>
                Привяжите личный аккаунт Telegram или WhatsApp либо подключите
                бота MAX. Добавить новые можно в любой момент.
              </DialogDescription>
            </DialogHeader>
            {proxies.length > 0 ? (
              <div className="mt-2 flex flex-col gap-2">
                <Label className="text-xs text-muted-foreground">
                  Через прокси (свой или назначенный администратором)
                </Label>
                <Select
                  value={proxyId}
                  onValueChange={(v) => setProxyId(v ?? 'none')}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Без прокси" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Без прокси (напрямую)</SelectItem>
                    {proxies.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label} · {p.kind}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="mt-3 grid gap-2">
              {OPTIONS.map((o) => {
                const Icon = o.icon
                return (
                  <button
                    key={o.type}
                    onClick={() => pick(o.type)}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-ring hover:bg-muted/40"
                  >
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                      <Icon className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{o.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {o.description}
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        ) : null}

        {/* TELEGRAM: phone */}
        {step === 'tg-phone' ? (
          <form action={submitPhone}>
            <input type="hidden" name="type" value="telegram" />
            <BackHeader onBack={() => setStep('pick')} title="Подключить Telegram" />
            <div className="my-4 flex flex-col gap-4">
              <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                Введите номер телефона аккаунта Telegram, который хотите
                привязать. Telegram отправит код входа на этот аккаунт.
              </p>
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Отображаемое имя</Label>
                <Input id="name" name="name" placeholder="Мой Telegram" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="phone">Номер телефона</Label>
                <Input
                  id="phone"
                  name="phone"
                  placeholder="+14155550132"
                  required
                />
              </div>
            </div>
            {error ? <ErrorNote message={error} /> : null}
            <DialogFooterRow onBack={() => setStep('pick')}>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Отправить код
              </Button>
            </DialogFooterRow>
          </form>
        ) : null}

        {/* TELEGRAM: code */}
        {step === 'tg-code' ? (
          <>
            <BackHeader onBack={() => setStep('tg-phone')} title="Введите код входа" />
            <div className="my-4 flex flex-col gap-4">
              {codeDelivery === 'app' ? (
                <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Код отправлен{' '}
                  <span className="font-medium text-foreground">
                    сообщением в приложение Telegram
                  </span>{' '}
                  — откройте Telegram на телефоне или в де��ктоп-приложении и
                  найдите чат «Telegram» (со синей галочкой). SMS не придёт.
                  Введите код ниже.
                </p>
              ) : codeDelivery === 'sms' ? (
                <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Код отправлен{' '}
                  <span className="font-medium text-foreground">по SMS</span>. Если
                  SMS не приходит (частая проблема для номеров РФ), войдите этим
                  номером в официальное приложение Telegram — тогда повторный код
                  придёт сообщением внутри приложения, а не по SMS.
                </p>
              ) : (
                <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Telegram отправляет код в чат «Telegram» внутри приложения (если
                  вы уже залогинены на этом номере) либо по SMS. Введите код ниже.
                </p>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="code">Код входа</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  placeholder="12345"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="font-mono tracking-widest"
                  autoFocus
                />
              </div>
              <Waiting label="Ожидаем ответа Telegram…" show={pending} />
            </div>
            {error ? <ErrorNote message={error} /> : null}
            <DialogFooterRow onBack={() => setStep('tg-phone')}>
              <Button onClick={submitCode} disabled={pending || !code.trim()}>
                Проверить код
              </Button>
            </DialogFooterRow>
          </>
        ) : null}

        {/* TELEGRAM: password (2FA) */}
        {step === 'tg-password' ? (
          <>
            <BackHeader onBack={() => setStep('tg-code')} title="Двухэтапная аутентификация" />
            <div className="my-4 flex flex-col gap-4">
              <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                На этом аккаунте включён облачный пароль (2FA). Введите его, чтобы
                завершить вход.
              </p>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Облачный пароль</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
              </div>
              <Waiting label="Проверяем…" show={pending} />
            </div>
            {error ? <ErrorNote message={error} /> : null}
            <DialogFooterRow onBack={() => setStep('tg-code')}>
              <Button onClick={submitPassword} disabled={pending || !password}>
                Войти
              </Button>
            </DialogFooterRow>
          </>
        ) : null}

        {/* MAX: bot token */}
        {step === 'max-token' ? (
          <form action={submitMaxToken}>
            <input type="hidden" name="type" value="max" />
            <BackHeader onBack={() => setStep('pick')} title="Подключить MAX" />
            <div className="my-4 flex flex-col gap-4">
              <ol className="w-full space-y-1.5 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <li>1. Откройте чат с @MasterBot в приложении MAX.</li>
                <li>
                  2. Создайте бота командой{' '}
                  <span className="font-medium text-foreground">/newbot</span>{' '}
                  и следуйте подсказкам.
                </li>
                <li>3. Скопируйте выданный токен и вставьте его ниже.</li>
              </ol>
              <div className="flex flex-col gap-2">
                <Label htmlFor="max-name">Отображаемое имя</Label>
                <Input
                  id="max-name"
                  name="name"
                  placeholder="Мой MAX-бот (необязательно)"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="max-token">Токен бота</Label>
                <Input
                  id="max-token"
                  name="token"
                  placeholder="Вставьте токен из @MasterBot"
                  autoComplete="off"
                  autoFocus
                  required
                />
              </div>
              <Waiting
                label="Проверяем токен и регистрируем вебхук…"
                show={pending}
              />
            </div>
            {error ? <ErrorNote message={error} /> : null}
            <DialogFooterRow onBack={() => setStep('pick')}>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Подключить
              </Button>
            </DialogFooterRow>
          </form>
        ) : null}

        {/* VK: community access token */}
        {step === 'vk-token' ? (
          <form action={submitVkToken}>
            <input type="hidden" name="type" value="vk" />
            <BackHeader onBack={() => setStep('pick')} title="Подключить VK" />
            <div className="my-4 flex flex-col gap-4">
              <ol className="w-full space-y-1.5 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <li>
                  1. Откройте «Управление сообществом» → «Настройки» → «Работа с
                  API».
                </li>
                <li>
                  2. Создайте ключ доступа со scope{' '}
                  <span className="font-medium text-foreground">Сообщения</span>{' '}
                  и{' '}
                  <span className="font-medium text-foreground">Управление</span>
                  .
                </li>
                <li>3. Скопируйте ключ и вставьте его ниже.</li>
              </ol>
              <div className="flex flex-col gap-2">
                <Label htmlFor="vk-name">Отображаемое имя</Label>
                <Input
                  id="vk-name"
                  name="name"
                  placeholder="Моё сообщество VK (необязательно)"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="vk-token">Ключ доступа сообщества</Label>
                <Input
                  id="vk-token"
                  name="token"
                  placeholder="Вставьте ключ доступа сообщества"
                  autoComplete="off"
                  autoFocus
                  required
                />
              </div>
              <Waiting
                label="Проверяем ключ и настраиваем Callback API…"
                show={pending}
              />
            </div>
            {error ? <ErrorNote message={error} /> : null}
            <DialogFooterRow onBack={() => setStep('pick')}>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Подключить
              </Button>
            </DialogFooterRow>
          </form>
        ) : null}

        {/* CONNECTED */}
        {step === 'connected' ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="size-7" />
            </div>
            <div className="space-y-1">
              <DialogTitle>Подключено</DialogTitle>
              <DialogDescription>
                Ваш аккаунт привязан и принимает сообщения.
              </DialogDescription>
            </div>
            <Button onClick={close}>Готово</Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------ helpers ------------------------------ */

function BackHeader({
  onBack,
  title,
}: {
  onBack: () => void
  title: string
}) {
  return (
    <DialogHeader>
      <button
        type="button"
        onClick={onBack}
        className="mb-2 flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Назад
      </button>
      <DialogTitle>{title}</DialogTitle>
    </DialogHeader>
  )
}

function DialogFooterRow({
  onBack,
  children,
}: {
  onBack?: () => void
  children?: React.ReactNode
}) {
  return (
    <div
      className={`flex items-center gap-2 ${
        onBack ? 'justify-between' : 'justify-end'
      }`}
    >
      {onBack ? (
        <Button type="button" variant="ghost" onClick={onBack}>
          Назад
        </Button>
      ) : null}
      {children}
    </div>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {message}
    </p>
  )
}

function Waiting({ label, show }: { label: string; show: boolean }) {
  if (!show) return null
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {label}
    </p>
  )
}

