'use client'

/**
 * Модалка многошагового Telegram-логина: QR / код из SMS-приложения / облачный
 * пароль 2FA + ошибка с ретраем. Открывается автоматически, как только начат
 * connect-флоу (tgChannelId задан), чтобы шаги было невозможно пропустить.
 */

import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import type { TgMethod, TgStep } from './use-create-account'

export function TelegramLoginDialog({
  open,
  method,
  phone,
  step,
  code,
  setCode,
  password,
  setPassword,
  qrImage,
  error,
  pending,
  onSubmitCode,
  onSubmitPassword,
  onRetry,
  onCancel,
}: {
  open: boolean
  method: TgMethod
  phone: string
  step: TgStep
  code: string
  setCode: (v: string) => void
  password: string
  setPassword: (v: string) => void
  qrImage: string | null
  error: string | null
  pending: boolean
  onSubmitCode: () => void
  onSubmitPassword: () => void
  onRetry: () => void
  onCancel: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Подключение Telegram</DialogTitle>
          <DialogDescription>
            {method === 'qr'
              ? 'Вход по QR-коду — без номера и SMS'
              : phone
                ? `Номер ${phone}`
                : 'Вход в аккаунт Telegram'}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <span className="text-pretty">{error}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={onRetry}
              disabled={pending}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {method === 'qr' ? 'Показать новый QR' : 'Запросить код повторно'}
            </Button>
          </div>
        ) : null}

        {step === 'qr' ? (
          <div className="flex flex-col items-center gap-3">
            {qrImage ? (
              // The QR encodes a tg://login deep link that rotates ~every 30s;
              // the poll swaps the image automatically, no user action needed.
              // A plain <img> is correct here: the source is a client-side
              // data URL (qrcode.toDataURL) — next/image can't optimize it.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrImage || '/placeholder.svg'}
                alt="QR-код для входа в Telegram"
                className="size-56 rounded-lg border border-border bg-white p-2"
              />
            ) : (
              <div className="flex size-56 items-center justify-center rounded-lg border border-border">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}
            <ol className="w-full list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              <li>Откройте Telegram на телефоне владельца аккаунта</li>
              <li>Настройки → Устройства → Подключить устройство</li>
              <li>Наведите камеру на QR-код</li>
            </ol>
            <p className="text-xs text-muted-foreground">
              Код обновляется автоматически. Если на аккаунте включена
              двухэтапная аутентификация, после сканирования попросим облачный
              пароль.
            </p>
          </div>
        ) : step === 'code' ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!pending && code.trim()) onSubmitCode()
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label>Код из Telegram</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="12345"
                inputMode="numeric"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    onSubmitCode()
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                Введите код, который пришёл в приложение Telegram или по SMS.
              </p>
            </div>
            <Button type="submit" disabled={pending || !code.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Отправить код
            </Button>
            <button
              type="button"
              onClick={onRetry}
              disabled={pending}
              className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
            >
              Код не пришёл или истёк — отправить повторно
            </button>
          </form>
        ) : step === 'password' ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!pending && password.trim()) onSubmitPassword()
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label>Пароль двухэтапной аутентификации</Label>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    onSubmitPassword()
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                На аккаунте включена двухэтапная аутентификация — введите
                облачный пароль Telegram.
              </p>
            </div>
            <Button type="submit" disabled={pending || !password.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Отправить пароль
            </Button>
          </form>
        ) : !error ? (
          <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            {method === 'qr'
              ? 'Генерируем QR-код… Это может занять несколько секунд.'
              : 'Запрашиваем код у Telegram… Это может занять несколько секунд.'}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Отменить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
