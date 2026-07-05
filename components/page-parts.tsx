import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ChannelStatus, SessionStatus } from '@/lib/types'

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-pretty text-xl font-semibold tracking-tight md:text-2xl">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string
  value: ReactNode
  icon: LucideIcon
  hint?: string
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight">{value}</div>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </Card>
  )
}

const STATUS_STYLES: Record<ChannelStatus, string> = {
  connected:
    'border-transparent bg-success/15 text-success [&_.dot]:bg-success',
  pending: 'border-transparent bg-warning/15 text-warning [&_.dot]:bg-warning',
  error:
    'border-transparent bg-destructive/15 text-destructive [&_.dot]:bg-destructive',
  disconnected:
    'border-transparent bg-muted text-muted-foreground [&_.dot]:bg-muted-foreground',
}

const STATUS_LABEL: Record<ChannelStatus, string> = {
  connected: 'Подключён',
  pending: 'Ожидание',
  error: 'Ошибка',
  disconnected: 'Отключён',
}

export function StatusBadge({ status }: { status: ChannelStatus }) {
  return (
    <Badge
      className={cn('gap-1.5 font-medium', STATUS_STYLES[status])}
      variant="outline"
    >
      <span className="dot size-1.5 rounded-full" />
      {STATUS_LABEL[status]}
    </Badge>
  )
}

const SESSION_STYLES: Record<SessionStatus, string> = {
  online: 'border-transparent bg-success/15 text-success [&_.dot]:bg-success',
  starting:
    'border-transparent bg-warning/15 text-warning [&_.dot]:bg-warning [&_.dot]:animate-pulse',
  qr_pending:
    'border-transparent bg-warning/15 text-warning [&_.dot]:bg-warning [&_.dot]:animate-pulse',
  code_pending:
    'border-transparent bg-warning/15 text-warning [&_.dot]:bg-warning [&_.dot]:animate-pulse',
  password_pending:
    'border-transparent bg-warning/15 text-warning [&_.dot]:bg-warning [&_.dot]:animate-pulse',
  offline:
    'border-transparent bg-muted text-muted-foreground [&_.dot]:bg-muted-foreground',
  idle: 'border-transparent bg-muted text-muted-foreground [&_.dot]:bg-muted-foreground',
  logged_out:
    'border-transparent bg-muted text-muted-foreground [&_.dot]:bg-muted-foreground',
  error:
    'border-transparent bg-destructive/15 text-destructive [&_.dot]:bg-destructive',
  rate_limited:
    'border-transparent bg-warning/15 text-warning [&_.dot]:bg-warning [&_.dot]:animate-pulse',
}

const SESSION_LABEL: Record<SessionStatus, string> = {
  online: 'В сети',
  starting: 'Запуск',
  qr_pending: 'Сканируйте QR',
  code_pending: 'Введите код',
  password_pending: 'Введите пароль',
  offline: 'Не в сети',
  idle: 'Простой',
  logged_out: 'Вышел',
  error: 'Ошибка',
  rate_limited: 'Пауза (лимит)',
}

export function SessionBadge({ status }: { status: SessionStatus }) {
  return (
    <Badge
      className={cn('gap-1.5 font-medium', SESSION_STYLES[status])}
      variant="outline"
    >
      <span className="dot size-1.5 rounded-full" />
      {SESSION_LABEL[status]}
    </Badge>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-border bg-muted/40">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="font-medium">{title}</h3>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
