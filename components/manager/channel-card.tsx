'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Pause,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { channelIcon } from '@/components/channel-icons'
import { toast } from 'sonner'
import {
  getChannelStatusAction,
  restartChannelAction,
} from '@/app/actions/channels'
import { SessionBadge, StatusBadge } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CHANNEL_META, type Channel } from '@/lib/types'
import { cn } from '@/lib/utils'

// How often the card re-checks a personal session, and the ceiling on
// consecutive automatic restart attempts before we stop and defer to the admin.
const POLL_MS = 15_000
const MAX_AUTO_ATTEMPTS = 4

function timeAgo(iso: string | null): string {
  if (!iso) return 'никогда'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'только что'
  if (mins < 60) return `${mins} мин назад`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} ч назад`
  return `${Math.floor(hours / 24)} дн назад`
}

export function ChannelCard({ channel }: { channel: Channel }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [sessionStatus, setSessionStatus] = useState(channel.sessionStatus)
  const [lastError, setLastError] = useState(channel.lastError)
  const [autoReconnecting, setAutoReconnecting] = useState(false)
  const attemptsRef = useRef(0)
  const Icon = channelIcon(channel.type)

  // Only Telegram is a socket-backed "personal" account that can drop and needs
  // reconnecting via the worker. WhatsApp (Cloud API), VK and MAX are all
  // webhook-based and always "online" as long as their token/webhook are valid.
  const isPersonal = channel.type === 'telegram'
  const paused = channel.ingestPaused

  // A session that logged out or is deliberately rate-limited must NOT be
  // auto-restarted: re-login needs the admin (code entry), and hammering a
  // rate-limited account risks a ban.
  const needsAdmin = sessionStatus === 'logged_out'
  const isDown = sessionStatus === 'offline' || sessionStatus === 'error'

  const restart = useCallback(
    (auto: boolean) => {
      startTransition(async () => {
        if (auto) setAutoReconnecting(true)
        const res = await restartChannelAction(channel.id)
        if (!auto) {
          if (res.ok) toast.success(res.message)
          else toast.error(res.message)
        }
        router.refresh()
      })
    },
    [channel.id, router],
  )

  // Live status polling + automatic reconnection for personal accounts. This is
  // the manager's only lever now that account creation/login lives with the
  // admin: if the session drops we quietly restart it (worker reuses the stored
  // session — no code needed), backing off after MAX_AUTO_ATTEMPTS.
  useEffect(() => {
    if (!isPersonal) return
    let cancelled = false

    async function tick() {
      const snap = await getChannelStatusAction(channel.id)
      if (cancelled || !snap) return
      setSessionStatus(snap.sessionStatus)
      setLastError(snap.lastError)

      if (snap.sessionStatus === 'online') {
        attemptsRef.current = 0
        setAutoReconnecting(false)
        return
      }
      const down =
        snap.sessionStatus === 'offline' || snap.sessionStatus === 'error'
      const blocked =
        snap.sessionStatus === 'logged_out' ||
        snap.sessionStatus === 'rate_limited'
      if (down && !blocked && attemptsRef.current < MAX_AUTO_ATTEMPTS) {
        attemptsRef.current += 1
        restart(true)
      } else if (attemptsRef.current >= MAX_AUTO_ATTEMPTS) {
        setAutoReconnecting(false)
      }
    }

    const id = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [channel.id, isPersonal, restart])

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
            <Icon className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{channel.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {CHANNEL_META[channel.type].label} · {channel.detail}
            </p>
          </div>
        </div>
        {isPersonal && (isDown || needsAdmin) ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => restart(false)}
            disabled={pending || needsAdmin}
            aria-label="Переподключить сейчас"
          >
            <RefreshCw className={cn('size-4', pending && 'animate-spin')} />
            Переподключить
          </Button>
        ) : null}
      </div>

      {needsAdmin ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">
            Сессия завершена. Повторный вход требует администратора — обратитесь к
            нему для переподключения аккаунта.
          </span>
        </p>
      ) : lastError ? (
        <p
          className={cn(
            'mt-3 flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-xs',
            sessionStatus === 'rate_limited'
              ? 'border-warning/30 bg-warning/10 text-warning'
              : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{lastError}</span>
        </p>
      ) : null}

      {autoReconnecting && !needsAdmin ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0 animate-spin" />
          <span className="break-words">
            Автоматическое переподключение…
          </span>
        </p>
      ) : null}

      {paused ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
          <Pause className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">
            Приём приостановлен администратором — аккаунт в сети, но новые
            сообщения не собираются.
          </span>
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isPersonal ? (
            <SessionBadge status={sessionStatus} />
          ) : (
            <StatusBadge status={channel.status} />
          )}
          {!isPersonal ? (
            <Badge className="gap-1.5 border-transparent bg-success/15 font-medium text-success">
              <ShieldCheck className="size-3" />
              Через прокси
            </Badge>
          ) : null}
          {paused ? (
            <Badge className="gap-1.5 border-transparent bg-warning/15 font-medium text-warning">
              <Pause className="size-3" />
              На паузе
            </Badge>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          Проверка {timeAgo(channel.lastCheckedAt)}
        </span>
      </div>
    </Card>
  )
}
