'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Loader2,
  RefreshCw,
  Send,
  Server,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  adminDeleteChannelAction,
  adminHealthCheckAction,
  adminReassignProxyAction,
  adminSetOutreachAction,
} from '@/app/actions/admin-accounts'
import { StatusBadge } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getChannelMeta, type Proxy } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { AdminChannel } from '@/lib/data'
import {
  SESSION_LABEL,
  TYPE_ICON,
  proxyLabelText,
} from '@/components/admin/account-shared'

export function AccountsTable({
  channels,
  proxies,
  proxyUsage,
}: {
  channels: AdminChannel[]
  proxies: Proxy[]
  proxyUsage: Record<string, string[]>
}) {
  if (channels.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Server className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm font-medium">Пока нет подключённых аккаунтов</p>
        <p className="text-xs text-muted-foreground">
          Подключите первый аккаунт в форме выше.
        </p>
      </Card>
    )
  }

  return (
    <Card className="divide-y divide-border">
      {channels.map((c) => (
        <AccountRow
          key={c.id}
          channel={c}
          proxies={proxies}
          proxyUsage={proxyUsage}
        />
      ))}
    </Card>
  )
}

function AccountRow({
  channel,
  proxies,
  proxyUsage,
}: {
  channel: AdminChannel
  proxies: Proxy[]
  proxyUsage: Record<string, string[]>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [checking, setChecking] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const Icon = TYPE_ICON[channel.type as keyof typeof TYPE_ICON] ?? Server

  function healthCheck() {
    setChecking(true)
    startTransition(async () => {
      const res = await adminHealthCheckAction(channel.id)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
      setChecking(false)
      router.refresh()
    })
  }

  // Proxies eligible to (re)assign to THIS account: right kind + not used by
  // another account of the same type (the account's current proxy is allowed).
  const eligible = useMemo(
    () =>
      proxies.filter((p) => {
        if (p.id === channel.proxyId) return true
        if (p.kind === 'mtproto' && channel.type !== 'telegram') return false
        const used = proxyUsage[p.id] ?? []
        return !used.includes(channel.type)
      }),
    [proxies, proxyUsage, channel.proxyId, channel.type],
  )

  // base-ui's <Select.Value> renders the raw value string unless we format it,
  // which is why the trigger showed a bare proxy UUID. Map id → readable label.
  const proxyLabelById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of proxies) m.set(p.id, proxyLabelText(p))
    return m
  }, [proxies])

  function reassign(proxyId: string) {
    // 'none' sentinel → detach the proxy (direct connection).
    const next = proxyId === 'none' ? null : proxyId
    startTransition(async () => {
      const res = await adminReassignProxyAction(channel.id, next)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  function toggleOutreach() {
    startTransition(async () => {
      const res = await adminSetOutreachAction(channel.id, !channel.isOutreach)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
      router.refresh()
    })
  }

  function remove() {
    startTransition(async () => {
      try {
        const res = await adminDeleteChannelAction(channel.id)
        if (res.ok) {
          toast.success(res.message)
          router.refresh()
        } else {
          toast.error(res.message)
        }
      } catch (err) {
        // A thrown server action (e.g. network/DB error) would otherwise leave
        // the dialog stuck with no feedback — surface it explicitly instead.
        console.error('delete channel failed:', err)
        toast.error('Не удалось удалить аккаунт. Попробуйте ещё раз.')
      } finally {
        setConfirmOpen(false)
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{channel.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {getChannelMeta(channel.type).label} · {channel.detail} ·{' '}
            {channel.managerName || 'Без менеджера'}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {channel.isOutreach ? (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
            title="С этого аккаунта менеджеры пишут лидам первыми"
          >
            <Send className="size-3" />
            Для исходящих
          </span>
        ) : null}
        <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
          {SESSION_LABEL[channel.sessionStatus] ?? channel.sessionStatus}
        </span>
        <StatusBadge status={channel.status} />
      </div>

      <div className="flex min-w-0 items-center gap-2 sm:w-72">
        {channel.proxyId ? null : (
          <ShieldAlert className="size-4 shrink-0 text-warning" />
        )}
        <Select
          value={channel.proxyId ?? 'none'}
          onValueChange={(v) => v && reassign(v)}
          disabled={pending}
        >
          <SelectTrigger className="h-9 min-w-0 flex-1">
            <SelectValue placeholder="Без прокси — напрямую">
              {(value: string | null) =>
                !value || value === 'none'
                  ? 'Без прокси — напрямую'
                  : (proxyLabelById.get(value) ?? 'Прокси назначен')
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Без прокси — напрямую</SelectItem>
            {eligible.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {proxyLabelText(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {channel.type === 'telegram' ? (
          <Button
            variant="outline"
            size="icon-sm"
            onClick={toggleOutreach}
            disabled={pending}
            aria-label={
              channel.isOutreach
                ? 'Снять назначение аккаунта для исходящих'
                : 'Назначить аккаунтом для исходящих сообщений менеджеров'
            }
            title={
              channel.isOutreach
                ? 'Аккаунт для исходящих — нажмите, чтобы снять'
                : 'Назначить для исходящих (менеджеры пишут лидам с него)'
            }
            className={cn(
              'shrink-0',
              channel.isOutreach &&
                'border-primary/50 bg-primary/10 text-primary hover:bg-primary/20',
            )}
          >
            <Send className="size-4" />
          </Button>
        ) : null}

        <Button
          variant="outline"
          size="icon-sm"
          onClick={healthCheck}
          disabled={pending}
          aria-label="Проверить связь / переподключить"
          title="Проверить связь"
          className="shrink-0"
        >
          <RefreshCw className={cn('size-4', checking && 'animate-spin')} />
        </Button>

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => setConfirmOpen(true)}
          disabled={pending}
          aria-label="Удалить аккаунт"
          title="Удалить аккаунт"
          className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить аккаунт?</DialogTitle>
            <DialogDescription>
              «{channel.name}» будет отключён, а его вебхук/сессия — остановлены.
              Историю переписок это не удаляет.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={pending}
            >
              Отмена
            </Button>
            <Button variant="destructive" onClick={remove} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Удалить
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
