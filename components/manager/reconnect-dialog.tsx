'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import {
  getChannelStatusAction,
  getPairingCodeAction,
  getQrAction,
  restartChannelAction,
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
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Channel, SessionStatus } from '@/lib/types'

type Step =
  | 'connecting'
  | 'wa-code'
  | 'tg-code'
  | 'tg-password'
  | 'connected'
  | 'error'

/**
 * Reconnect an EXISTING personal channel. Unlike the connect wizard this never
 * creates a channel: it re-runs the worker session (restart job) and, when the
 * provider needs the account re-linked, surfaces the SAME interactive steps as
 * first-time linking — a fresh WhatsApp pairing code / QR, or a new Telegram
 * login code / 2FA password — so the operator can finish the handshake.
 *
 * A silently-resumable session (valid saved creds) just goes straight to
 * "connected" without asking for anything.
 */
export function ReconnectDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: Channel
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const isWhatsapp = channel.type === 'whatsapp'
  const [step, setStep] = useState<Step>('connecting')
  const [pending, startTransition] = useTransition()
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [codeDelivery, setCodeDelivery] = useState<'app' | 'sms' | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollStartRef = useRef<number>(0)
  // Guard so the restart kick-off runs once per open, not on every render.
  const startedRef = useRef(false)
  // Whether anything changed and the connections list should refresh on close.
  const dirtyRef = useRef(false)

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  // React to a polled session status. Only ever advances the flow.
  function applyStatus(status: SessionStatus, lastError: string | null) {
    if (status === 'online') {
      stopPolling()
      dirtyRef.current = true
      setError(null)
      setStep('connected')
    } else if (status === 'code_pending' || status === 'qr_pending') {
      setStep(isWhatsapp ? 'wa-code' : 'tg-code')
    } else if (status === 'password_pending') {
      setStep('tg-password')
    } else if (
      status === 'error' ||
      status === 'logged_out' ||
      status === 'rate_limited'
    ) {
      stopPolling()
      setError(
        lastError ??
          (status === 'logged_out'
            ? 'Этот аккаунт вышел из системы. Переподключитесь, чтобы снова привязать его.'
            : status === 'rate_limited'
              ? 'Пауза для защиты аккаунта от блокировки. Подождите немного и попробуйте снова.'
              : 'Не удалось переподключиться. Попробуйте ещё раз.'),
      )
      setStep('error')
    }
  }

  function startPolling() {
    stopPolling()
    pollStartRef.current = Date.now()
    pollRef.current = setInterval(async () => {
      // Backstop so the spinner never hangs forever (worker down / dead proxy).
      if (Date.now() - pollStartRef.current > 150_000) {
        stopPolling()
        setError(
          'Истекло время ожидания воркера. Проверьте, что он запущен, и попробуйте снова.',
        )
        setStep('error')
        return
      }
      const snap = await getChannelStatusAction(channel.id)
      if (!snap) return
      if (snap.codeDelivery) setCodeDelivery(snap.codeDelivery)
      if (isWhatsapp && snap.sessionStatus !== 'online') {
        const { code: c } = await getPairingCodeAction(channel.id)
        if (c) setPairingCode(c)
        if (snap.sessionStatus === 'qr_pending') {
          const { qr: q } = await getQrAction(channel.id)
          if (q) setQr(q)
        }
      }
      applyStatus(snap.sessionStatus, snap.lastError)
    }, 2000)
  }

  // Kick off a restart whenever the dialog opens, and clean up when it closes.
  useEffect(() => {
    if (!open) {
      startedRef.current = false
      stopPolling()
      return
    }
    if (startedRef.current) return
    startedRef.current = true
    setStep('connecting')
    setPairingCode(null)
    setQr(null)
    setCode('')
    setPassword('')
    setError(null)
    setCodeDelivery(null)
    startTransition(async () => {
      const res = await restartChannelAction(channel.id)
      if (!res.ok) {
        setError(res.message)
        setStep('error')
        return
      }
      dirtyRef.current = true
      startPolling()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => () => stopPolling(), [])

  function close() {
    stopPolling()
    const needsRefresh = dirtyRef.current
    dirtyRef.current = false
    onOpenChange(false)
    if (needsRefresh) setTimeout(() => router.refresh(), 150)
  }

  function retry() {
    setError(null)
    setPairingCode(null)
    setQr(null)
    setStep('connecting')
    startTransition(async () => {
      const res = await restartChannelAction(channel.id)
      if (!res.ok) {
        setError(res.message)
        setStep('error')
        return
      }
      startPolling()
    })
  }

  function submitCode() {
    if (!code.trim()) return
    startTransition(async () => {
      const res = await submitTelegramCodeAction(channel.id, code)
      if (!res.ok) {
        setError(res.message)
        return
      }
      setStep('connecting')
      startPolling()
    })
  }

  function submitPassword() {
    if (!password) return
    startTransition(async () => {
      const res = await submitTelegramPasswordAction(channel.id, password)
      if (!res.ok) {
        setError(res.message)
        return
      }
      setStep('connecting')
      startPolling()
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        {/* CONNECTING */}
        {step === 'connecting' ? (
          <>
            <DialogHeader>
              <DialogTitle>Переподключение {channel.name}</DialogTitle>
              <DialogDescription>
                Восстанавливаем сессию. Если аккаунт нужно привязать заново, код
                появится здесь.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              Связываемся с{' '}
              {channel.type === 'whatsapp' ? 'WhatsApp' : 'Telegram'}…
            </div>
          </>
        ) : null}

        {/* WHATSAPP: pairing code / QR */}
        {step === 'wa-code' ? (
          <>
            <DialogHeader>
              <DialogTitle>Привязка по номеру телефона</DialogTitle>
              <DialogDescription>
                Вашу сессию WhatsApp нужно привязать заново.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 flex flex-col gap-4">
              {qr ? (
                <>
                  <ol className="w-full space-y-1.5 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                    <li>1. Откройте WhatsApp на телефоне.</li>
                    <li>
                      2. Нажмите Меню → Связанные устройства → Привязка
                      устройства.
                    </li>
                    <li>3. Отсканируйте QR-код ниже.</li>
                  </ol>
                  <div className="flex items-center justify-center rounded-xl border border-border bg-background p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qr || '/placeholder.svg'}
                      alt="QR-код для привязки WhatsApp"
                      width={220}
                      height={220}
                      className="size-[220px]"
                    />
                  </div>
                </>
              ) : (
                <>
                  <ol className="w-full space-y-1.5 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                    <li>1. Откройте WhatsApp на телефоне.</li>
                    <li>
                      2. Нажмите Меню → Связанные устройства → Привязка
                      устройства.
                    </li>
                    <li>
                      3. Нажмите{' '}
                      <span className="font-medium text-foreground">
                        Привязать по номеру телефона
                      </span>
                      .
                    </li>
                    <li>4. Введите код ниже.</li>
                  </ol>
                  <div className="flex min-h-20 items-center justify-center rounded-xl border border-border bg-background p-4">
                    {pairingCode ? (
                      <span className="font-mono text-3xl font-semibold tracking-[0.3em] text-foreground">
                        {pairingCode}
                      </span>
                    ) : (
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        Генерируем код привязки…
                      </span>
                    )}
                  </div>
                </>
              )}
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Ожидаем завершения привязки…
              </p>
            </div>
          </>
        ) : null}

        {/* TELEGRAM: code */}
        {step === 'tg-code' ? (
          <>
            <DialogHeader>
              <DialogTitle>Введите код входа</DialogTitle>
              <DialogDescription>
                {codeDelivery === 'app'
                  ? 'Telegram отправил код сообщением в служебный чат Telegram.'
                  : codeDelivery === 'sms'
                    ? 'Telegram отправил код по SMS.'
                    : 'Telegram отправил код входа на аккаунт.'}
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="rc-code">Код входа</Label>
                <Input
                  id="rc-code"
                  inputMode="numeric"
                  placeholder="12345"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="font-mono tracking-widest"
                  autoFocus
                />
              </div>
              {error ? <ErrorNote message={error} /> : null}
            </div>
            <div className="flex justify-end">
              <Button onClick={submitCode} disabled={pending || !code.trim()}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Проверить код
              </Button>
            </div>
          </>
        ) : null}

        {/* TELEGRAM: 2FA password */}
        {step === 'tg-password' ? (
          <>
            <DialogHeader>
              <DialogTitle>Двухэтапная аутентификация</DialogTitle>
              <DialogDescription>
                Введите облачный пароль аккаунта, чтобы завершить вход.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 flex flex-col gap-4">
              <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                На этом аккаунте включён облачный пароль (2FA).
              </p>
              <div className="flex flex-col gap-2">
                <Label htmlFor="rc-pass">Облачный пароль</Label>
                <Input
                  id="rc-pass"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
              </div>
              {error ? <ErrorNote message={error} /> : null}
            </div>
            <div className="flex justify-end">
              <Button onClick={submitPassword} disabled={pending || !password}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Войти
              </Button>
            </div>
          </>
        ) : null}

        {/* ERROR */}
        {step === 'error' ? (
          <>
            <DialogHeader>
              <DialogTitle>Не удалось переподключиться</DialogTitle>
              <DialogDescription>
                Сессию не получилось восстановить.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 flex flex-col gap-4">
              {error ? <ErrorNote message={error} /> : null}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={close}>
                  Закрыть
                </Button>
                <Button onClick={retry} disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  Попробовать снова
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {/* CONNECTED */}
        {step === 'connected' ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="size-7" />
            </div>
            <div className="space-y-1">
              <DialogTitle>Переподключено</DialogTitle>
              <DialogDescription>
                {channel.name} снова в сети и принимает сообщения.
              </DialogDescription>
            </div>
            <Button onClick={close}>Готово</Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {message}
    </p>
  )
}
