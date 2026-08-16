'use client'

/** Мастер включения 2FA через приложение-аутентификатор (QR + код). */
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { WizardStep } from './shared'

export function TotpWizard({
  secret,
  qrDataUrl,
  pending,
  onConfirm,
  onCancel,
}: {
  secret: string
  qrDataUrl: string
  pending: boolean
  onConfirm: (formData: FormData) => void
  onCancel: () => void
}) {
  return (
    <Card className="p-5">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="flex shrink-0 flex-col items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- локальный data: URL, next/image не нужен */}
          <img
            src={qrDataUrl || '/placeholder.svg'}
            alt="QR-код для приложения-аутентификатора"
            className="size-44 rounded-lg bg-white p-2"
          />
          <p className="max-w-44 break-all text-center font-mono text-[11px] leading-tight text-muted-foreground">
            {secret}
          </p>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <WizardStep n={1} title="Отсканируйте QR-код">
            Откройте приложение (Google Authenticator, 1Password и т.п.) и
            добавьте аккаунт по QR-коду. Если камера недоступна — введите
            секрет под кодом вручную.
          </WizardStep>
          <WizardStep n={2} title="Введите код из приложения">
            Приложение покажет 6-значный код, который обновляется каждые 30
            секунд.
          </WizardStep>
          <form action={onConfirm} className="flex max-w-xs gap-2">
            <Input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123 456"
              maxLength={7}
              required
              className="text-center font-mono tracking-widest"
              aria-label="Код из приложения"
            />
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                'Включить'
              )}
            </Button>
          </form>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={onCancel}
          >
            Отмена
          </Button>
        </div>
      </div>
    </Card>
  )
}
