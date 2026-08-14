'use client'

/**
 * Общие типы и мелкие кирпичики страницы 2FA: состояние мастера, подписи
 * методов, пронумерованный шаг, карточка выбора метода и одноразовый показ
 * резервных кодов. Контейнер с состоянием — ../twofa-settings.tsx.
 */
import { useState } from 'react'
import { Check, Copy, KeyRound, Loader2, Smartphone } from 'lucide-react'
import type { TwofaStatus } from '@/app/actions/twofa'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/** Экран, который сейчас показывает страница 2FA. */
export type Wizard =
  | { kind: 'none' }
  | { kind: 'totp'; secret: string; qrDataUrl: string }
  | {
      kind: 'telegram'
      token: string
      botUsername: string
      chats: { chatId: string; name: string }[]
      selected: string[]
      challengeId: string | null
    }
  | { kind: 'backup'; codes: string[] }

export const METHOD_LABEL: Record<TwofaStatus['method'], string> = {
  off: 'Выключена',
  totp: 'Приложение-аутентификатор',
  telegram: 'Telegram-бот',
}

/** Пронумерованный шаг мастера настройки. */
export function WizardStep({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-6">{title}</p>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

/** Карточка выбора метода 2FA. */
export function MethodCard({
  icon: Icon,
  title,
  badge,
  description,
  actionLabel,
  pending,
  onStart,
}: {
  icon: typeof Smartphone
  title: string
  badge?: string
  description: string
  actionLabel: string
  pending: boolean
  onStart: () => void
}) {
  return (
    <Card className="group flex flex-col gap-3 p-5 transition-colors hover:border-primary/40">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="size-5" aria-hidden />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          {badge && (
            <Badge
              variant="outline"
              className="border-primary/30 bg-primary/5 text-primary"
            >
              {badge}
            </Badge>
          )}
        </div>
      </div>
      <p className="flex-1 text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <Button
        onClick={onStart}
        disabled={pending}
        variant="outline"
        className="self-start bg-transparent"
      >
        {pending && <Loader2 className="size-4 animate-spin" />}
        {actionLabel}
      </Button>
    </Card>
  )
}

/** One-time backup-codes reveal with a copy-all button. */
export function BackupCodes({
  codes,
  onDone,
}: {
  codes: string[]
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Card className="border-primary/40 bg-primary/5 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
          <KeyRound className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Резервные коды — сохраните их сейчас
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Каждый код одноразовый и подходит вместо кода из
            приложения/Telegram. Больше они не будут показаны.
          </p>
          <div className="mt-3 grid max-w-xs grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border bg-card p-3 font-mono text-sm">
            {codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(codes.join('\n')).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }}
            >
              {copied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
              {copied ? 'Скопировано' : 'Скопировать все'}
            </Button>
            <Button size="sm" onClick={onDone}>
              Готово
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}
