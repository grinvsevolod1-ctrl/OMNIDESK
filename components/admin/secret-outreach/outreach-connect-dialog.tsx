'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { toast } from 'sonner'
import { Loader2, QrCode, Smartphone, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { SessionStatus } from '@/lib/types'
import { outreachCreateAndConnectAction } from '@/app/actions/admin-secret/outreach-accounts'
import {
  personalGetQrAction,
  personalGetStatusAction,
  personalRestartQrAction,
  personalResendCodeAction,
  personalSubmitCodeAction,
  personalSubmitPasswordAction,
} from '@/app/actions/admin-secret/telegram-personal'

type Step = 'form' | 'qr' | 'code' | 'password' | 'done'

/**
 * Мастер подключения боевого аккаунта исходящих. Создание аккаунта + канала —
 * outreachCreateAndConnectAction (автоподбор api-ключа из пула). Дальнейший
 * QR/код/2FA-флоу переиспользует personal*-экшены по channelId.
 */
export function OutreachConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected: () => void
}) {
  const [step, setStep] = useState<Step>('form')
  const [label, setLabel] = useState('')
  const [method, setMethod] = useState<'qr' | 'phone'>('qr')
  const [phone, setPhone] = useState('')
  const [proxy, setProxy] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [channelId, setChannelId] = useState<string | null>(null)
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const [codeDelivery, setCodeDelivery] = useState<'app' | 'sms' | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const qrTextRef = useRef('')

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  useEffect(() => {
    if (open) return
    stopPolling()
    const t = setTimeout(() => {
      setStep('form')
      setLabel('')
      setMethod('qr')
      setPhone('')
      setProxy('')
      setCode('')
      setPassword('')
      setChannelId(null)
      setQrImage(null)
      setLastError(null)
      setCodeDelivery(null)
      qrTextRef.current = ''
    }, 200)
    return () => clearTimeout(t)
  }, [open, stopPolling])

  const startPolling = useCallback(
    (id: string, mode: 'qr' | 'phone') => {
      stopPolling()
      pollRef.current = setInterval(async () => {
        if (document.hidden) return
        const status = await personalGetStatusAction(id).catch(() => null)
        if (!status) return
        setLastError(status.lastError)
        setCodeDelivery(status.codeDelivery)
        const s: SessionStatus = status.sessionStatus
        if (s === 'online') {
          stopPolling()
          setStep('done')
          toast.success('Аккаунт подключён')
          onConnected()
          return
        }
        if (s === 'code_pending') setStep('code')
        else if (s === 'password_pending') setStep('password')
        if (mode === 'qr' && (s === 'qr_pending' || s === 'starting')) {
          const data = await personalGetQrAction(id).catch(() => null)
          if (data?.qr && data.qr !== qrTextRef.current) {
            qrTextRef.current = data.qr
            const img = await QRCode.toDataURL(data.qr, {
              margin: 1,
              width: 480,
            }).catch(() => null)
            if (img) setQrImage(img)
          }
        }
      }, 2_000)
    },
    [stopPolling, onConnected],
  )

  async function begin() {
    if (method === 'phone' && phone.trim().length < 7) {
      toast.error('Введите номер телефона')
      return
    }
    setBusy(true)
    const res = await outreachCreateAndConnectAction({
      label,
      mode: method,
      phone: method === 'phone' ? phone : undefined,
      proxy: proxy.trim() || undefined,
    })
    setBusy(false)
    if (!res.ok || !res.channelId) {
      toast.error(res.message)
      return
    }
    setChannelId(res.channelId)
    setStep(method === 'qr' ? 'qr' : 'code')
    startPolling(res.channelId, method)
    if (method === 'phone') toast.success(res.message)
  }

  async function submitCode() {
    if (!channelId || code.trim().length < 3) return
    setBusy(true)
    const res = await personalSubmitCodeAction(channelId, code)
    setBusy(false)
    if (!res.ok) toast.error(res.message)
  }

  async function submitPassword() {
    if (!channelId || !password) return
    setBusy(true)
    const res = await personalSubmitPasswordAction(channelId, password)
    setBusy(false)
    if (!res.ok) toast.error(res.message)
  }

  async function restartQr() {
    if (!channelId) return
    setBusy(true)
    qrTextRef.current = ''
    setQrImage(null)
    const res = await personalRestartQrAction(channelId)
    setBusy(false)
    if (!res.ok) toast.error(res.message)
  }

  async function resendCode() {
    if (!channelId) return
    setBusy(true)
    const res = await personalResendCodeAction(channelId)
    setBusy(false)
    if (res.ok) toast.success(res.message)
    else toast.error(res.message)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Подключить боевой аккаунт</DialogTitle>
          <DialogDescription>
            {step === 'form' &&
              'Аккаунт попадёт в пул исходящих. API-ключ подберётся автоматически из наименее загруженного.'}
            {step === 'qr' &&
              'Telegram → Настройки → Устройства → Подключить устройство'}
            {step === 'code' &&
              (codeDelivery === 'sms'
                ? 'Код отправлен по SMS.'
                : 'Код отправлен в приложение Telegram.')}
            {step === 'password' && 'Аккаунт защищён паролем 2FA.'}
            {step === 'done' && 'Готово — аккаунт в пуле исходящих.'}
          </DialogDescription>
        </DialogHeader>

        {lastError && step !== 'done' ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {lastError}
          </p>
        ) : null}

        {step === 'form' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oc-label">Метка аккаунта</Label>
              <Input
                id="oc-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Например: Прогрев #1"
                maxLength={80}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setMethod('qr')}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-xl border p-4 text-sm font-medium transition-colors',
                  method === 'qr'
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card hover:bg-muted/60',
                )}
              >
                <QrCode className="size-6" />
                QR-код
              </button>
              <button
                type="button"
                onClick={() => setMethod('phone')}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-xl border p-4 text-sm font-medium transition-colors',
                  method === 'phone'
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card hover:bg-muted/60',
                )}
              >
                <Smartphone className="size-6" />
                По номеру
              </button>
            </div>
            {method === 'phone' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="oc-phone">Номер телефона</Label>
                <Input
                  id="oc-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+7 999 123-45-67"
                  inputMode="tel"
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oc-proxy">Прокси (необязательно)</Label>
              <Input
                id="oc-proxy"
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                placeholder="socks5://user:pass@host:port"
                autoComplete="off"
              />
            </div>
            <Button onClick={() => void begin()} disabled={busy} className="gap-1.5">
              {busy && <Loader2 className="size-4 animate-spin" />}
              Подключить
            </Button>
          </div>
        )}

        {step === 'qr' && (
          <div className="flex flex-col items-center gap-3">
            {qrImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrImage || '/placeholder.svg'}
                alt="QR-код для входа в Telegram"
                className="size-56 rounded-xl border border-border bg-white p-2"
              />
            ) : (
              <div className="flex size-56 items-center justify-center rounded-xl border border-dashed border-border">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void restartQr()}
              disabled={busy}
              className="gap-1.5"
            >
              <RefreshCw className="size-3.5" />
              Новый QR
            </Button>
          </div>
        )}

        {step === 'code' && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submitCode()
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oc-code">Код входа</Label>
              <Input
                id="oc-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="12345"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                disabled={busy || code.trim().length < 3}
                className="flex-1"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Подтвердить
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void resendCode()}
                disabled={busy}
              >
                Ещё раз
              </Button>
            </div>
          </form>
        )}

        {step === 'password' && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submitPassword()
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oc-2fa">Пароль 2FA</Label>
              <Input
                id="oc-2fa"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </div>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Войти
            </Button>
          </form>
        )}

        {step === 'done' && (
          <Button onClick={() => onOpenChange(false)}>Закрыть</Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
