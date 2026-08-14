'use client'

/** Статус-карточка страницы 2FA: включено/выключено, метод, бейджи. */
import { KeyRound, Send, ShieldCheck, ShieldOff } from 'lucide-react'
import type { TwofaStatus } from '@/app/actions/twofa'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { METHOD_LABEL } from './shared'

export function TwofaStatusCard({ status }: { status: TwofaStatus }) {
  const enabled = status.method !== 'off'
  return (
    <Card className="relative overflow-hidden p-0">
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b to-transparent',
          enabled ? 'from-success/[0.08]' : 'from-muted/60',
        )}
      />
      <div className="relative flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <div
          className={cn(
            'flex size-14 shrink-0 items-center justify-center rounded-xl border',
            enabled
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          {enabled ? (
            <ShieldCheck className="size-7" aria-hidden />
          ) : (
            <ShieldOff className="size-7" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold">
            {enabled ? 'Защита включена' : 'Защита выключена'}
          </p>
          <p className="text-sm text-muted-foreground">
            {enabled ? (
              <>
                Метод: {METHOD_LABEL[status.method]}
                {status.enabledAt &&
                  ` · с ${new Date(status.enabledAt).toLocaleDateString('ru-RU')}`}
              </>
            ) : (
              'Вход только по паролю. Добавьте второй фактор — даже украденный пароль не даст войти в аккаунт.'
            )}
          </p>
        </div>
        {enabled && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Badge variant="secondary" className="gap-1">
              <KeyRound className="size-3" aria-hidden />
              Резервных кодов: {status.backupCodesLeft}
            </Badge>
            {status.method === 'telegram' && (
              <Badge variant="secondary" className="gap-1">
                <Send className="size-3" aria-hidden />
                Получателей: {status.telegramRecipients}
              </Badge>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
