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
import {
  personalConnectPhoneAction,
  personalConnectQrAction,
  personalGetQrAction,
  personalGetStatusAction,
  personalRestartQrAction,
  personalResendCodeAction,
  personalSubmitCodeAction,
  personalSubmitPasswordAction,
} from '@/app/actions/admin-secret/telegram-personal'

type Step = 'method' | 'qr' | 'phone' | 'code' | 'password' | 'done'

/**
 * Мастер подключения личного аккаунта: QR (поллинг живого deep link) или
 * телефон → код → 2FA. Статусы едут через session_status канала — тот же
 * конвейер джобов, что у продавца, но manager_id = NULL и personalMode.
 */
export function AccountConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected: () => void
}) {
  const [step, setStep] = useState<Step>('method')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
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
    if (!open) {
      stopPolling()
      setStep('method')
      setName('')
      setPhone('')
      setCode('')
      setPassword('')
      setChannelId(null)
      setQrImage(null)
      setLastError(null)
      setCodeDelivery(null)
      qrTextRef.current = ''
    }
  }, [open, stopPolling])

  /** Поллинг статуса + (для QR) живого deep link. */
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
        else if (s === 'error' || s === 'logged_out') {
          // остаёмся на шаге — lastError покажет причину
        }
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

  async function beginQr() {
    setBusy(true)
    const res = await personalConnectQrAction(name)
    setBusy(false)
    if (!res.ok || !res.channelId) {
      toast.error(res.message)
      return
    }
    setChannelId(res.channelId)
    setStep('qr')
    startPolling(res.channelId, 'qr')
  }

  async function beginPhone() {
    setBusy(true)
    const res = await personalConnectPhoneAction(name, phone)
    setBusy(false)
    if (!res.ok || !res.channelId) {
      toast.error(res.message)
      return
    }
    setChannelId(res.channelId)
    startPolling(res.channelId, 'phone')
    toast.success(res.message)
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
          <DialogTitle>Подключить аккаунт</DialogTitle>
          <DialogDescription>
            {step === 'method' &&
              'Личный Telegram-аккаунт. Переписка живёт только в Telegram — на сервере ничего не сохраняется.'}
            {step === 'qr' &&
              'Telegram → Настройки → Устройства → Подключить устройство'}
            {step === 'phone' && 'Введите номер — Telegram пришлёт код входа.'}
            {step === 'code' &&
              (codeDelivery === 'sms'
                ? 'Код отправлен по SMS.'
                : 'Код отправлен в приложение Telegram.')}
            {step === 'password' && 'Аккаунт защищён паролем 2FA.'}
            {step === 'done' && 'Готово — аккаунт в списке.'}
          </DialogDescription>
        </DialogHeader>

        {lastError && step !== 'done' ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {lastError}
          </p>
        ) : null}

        {step === 'method' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-name">Название (для себя)</Label>
              <Input
                id="acc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например: Основной"
                maxLength={80}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void beginQr()}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm font-medium transition-colors hover:bg-muted/60',
                  busy && 'opacity-60',
                )}
              >
                <QrCode className="size-6" />
                QR-код
                <span className="text-xs font-normal text-muted-foreground">
                  Сканировать с телефона
                </span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep('phone')}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm font-medium transition-colors hover:bg-muted/60',
                  busy && 'opacity-60',
                )}
              >
                <Smartphone className="size-6" />
                По номеру
                <span className="text-xs font-normal text-muted-foreground">
                  Код + пароль 2FA
                </span>
              </button>
            </div>
          </div>
        )}

        {step === 'qr' && (
          <div className="flex flex-col items-center gap-3">
            {qrImage ? (
              // data URL — next/image его не оптимизирует
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

        {step === 'phone' && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void beginPhone()
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="acc-phone">Номер телефона</Label>
              <Input
                id="acc-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+7 999 123-45-67"
                inputMode="tel"
                autoFocus
              />
            </div>
            <Button type="submit" disabled={busy || phone.trim().length < 7}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Получить код
            </Button>
          </form>
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
              <Label htmlFor="acc-code">Код входа</Label>
              <Input
                id="acc-code"
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
              <Label htmlFor="acc-2fa">Пароль 2FA</Label>
              <Input
                id="acc-2fa"
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
