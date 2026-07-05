import Link from 'next/link'
import { AlertTriangle, PauseCircle, WifiOff } from 'lucide-react'
import type { ChannelType, SessionStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface DegradedAccount {
  id: string
  name: string
  type: ChannelType
  sessionStatus: SessionStatus
  lastError: string | null
}

/**
 * Per-status presentation. `rate_limited` is the most important one to call out
 * clearly (the account is deliberately cooling down to avoid a ban), so it gets
 * a distinct, calmer "paused" treatment rather than a hard error.
 */
const STATUS_PRESENTATION: Record<
  string,
  { label: string; tone: 'warning' | 'muted' | 'destructive' }
> = {
  rate_limited: { label: 'на паузе (защита от блокировки)', tone: 'warning' },
  offline: { label: 'переподключается', tone: 'muted' },
  error: { label: 'ошибка подключения', tone: 'destructive' },
  logged_out: { label: 'требуется повторный вход', tone: 'destructive' },
}

/**
 * Inbox-level health strip for personal accounts whose live session is degraded.
 * Lets the operator know sync for those sources may lag — and links straight to
 * Connections to fix it — without mistaking it for "no new messages".
 */
export function AccountHealthBanner({
  accounts,
}: {
  accounts: DegradedAccount[]
}) {
  if (accounts.length === 0) return null

  const hasHardFailure = accounts.some(
    (a) => a.sessionStatus === 'error' || a.sessionStatus === 'logged_out',
  )
  const Icon = hasHardFailure
    ? AlertTriangle
    : accounts.some((a) => a.sessionStatus === 'rate_limited')
      ? PauseCircle
      : WifiOff

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-col gap-2 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        hasHardFailure
          ? 'border-destructive/30 bg-destructive/10'
          : 'border-warning/30 bg-warning/10',
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon
          className={cn(
            'mt-0.5 size-4 shrink-0',
            hasHardFailure ? 'text-destructive' : 'text-warning',
          )}
        />
        <div className="min-w-0 space-y-1">
          <p
            className={cn(
              'text-sm font-medium',
              hasHardFailure ? 'text-destructive' : 'text-warning',
            )}
          >
            {accounts.length === 1
              ? 'Один аккаунт требует внимания'
              : `${accounts.length} аккаунта требуют внимания`}
          </p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {accounts.map((a) => {
              const p =
                STATUS_PRESENTATION[a.sessionStatus] ??
                STATUS_PRESENTATION.offline
              return (
                <li key={a.id} className="flex items-center gap-1.5">
                  <span className="font-medium text-foreground">{a.name}</span>
                  <span>— {p.label}</span>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
      <Link
        href="/app/connections"
        className="shrink-0 self-start rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:self-center"
      >
        Открыть подключения
      </Link>
    </div>
  )
}
