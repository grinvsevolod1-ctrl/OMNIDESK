'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  LogOut,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Phone,
  Play,
  RefreshCw,
  Send,
  Trash2,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteChannelAction,
  logoutChannelAction,
  pauseChannelAction,
  resumeChannelAction,
} from '@/app/actions/channels'
import { ReconnectDialog } from '@/components/manager/reconnect-dialog'
import { SessionBadge, StatusBadge } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CHANNEL_META, type Channel, type ChannelType } from '@/lib/types'
import { cn } from '@/lib/utils'

const ICONS: Record<ChannelType, typeof Send> = {
  telegram: Send,
  whatsapp: Phone,
  livechat: MessageCircle,
  max: MessageSquare,
  vk: Users,
}

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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [reconnectOpen, setReconnectOpen] = useState(false)
  const Icon = ICONS[channel.type]
  // Cloud API WhatsApp has no worker session (no QR/reconnect/logout) — it
  // behaves like MAX/live-chat. Only Telegram + legacy Baileys WhatsApp are
  // "personal" socket-backed accounts.
  const isCloudWhatsapp =
    channel.type === 'whatsapp' && channel.config?.provider === 'cloud'
  const isPersonal =
    channel.type === 'telegram' ||
    (channel.type === 'whatsapp' && !isCloudWhatsapp)
  const paused = channel.ingestPaused

  // Run a lifecycle action, surface the result, and refresh the list so the
  // badge/menu reflect the new state.
  function run(fn: (id: string) => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const res = await fn(channel.id)
      if (res.ok) {
        toast.success(res.message)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  function logout() {
    startTransition(async () => {
      const res = await logoutChannelAction(channel.id)
      if (res.ok) {
        toast.success(res.message)
        setConfirmLogout(false)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  function remove() {
    startTransition(async () => {
      const res = await deleteChannelAction(channel.id)
      if (res.ok) {
        toast.success(res.message)
        setConfirmDelete(false)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

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
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="Действия с каналом">
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-52">
            {isPersonal ? (
              <>
                <DropdownMenuItem
                  onClick={() => setReconnectOpen(true)}
                  disabled={pending}
                  render={
                    <span className="flex cursor-pointer items-center gap-2">
                      <RefreshCw className="size-4" />
                      Переподключить
                    </span>
                  }
                />
                {paused ? (
                  <DropdownMenuItem
                    onClick={() => run(resumeChannelAction)}
                    disabled={pending}
                    render={
                      <span className="flex cursor-pointer items-center gap-2">
                        <Play className="size-4" />
                        Возобновить приём
                      </span>
                    }
                  />
                ) : (
                  <DropdownMenuItem
                    onClick={() => run(pauseChannelAction)}
                    disabled={pending}
                    render={
                      <span className="flex cursor-pointer items-center gap-2">
                        <Pause className="size-4" />
                        Приостановить приём
                      </span>
                    }
                  />
                )}
                <DropdownMenuItem
                  onClick={() => setConfirmLogout(true)}
                  disabled={pending}
                  render={
                    <span className="flex cursor-pointer items-center gap-2">
                      <LogOut className="size-4" />
                      Выйти
                    </span>
                  }
                />
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
              render={
                <span className="flex cursor-pointer items-center gap-2">
                  <Trash2 className="size-4" />
                  Удалить
                </span>
              }
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {channel.lastError ? (
        // A rate-limited session is a deliberate protective pause, not a hard
        // failure — show it in a calmer "warning" tone so operators don't treat
        // the cooldown as a broken account.
        <p
          className={cn(
            'mt-3 flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-xs',
            channel.sessionStatus === 'rate_limited'
              ? 'border-warning/30 bg-warning/10 text-warning'
              : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{channel.lastError}</span>
        </p>
      ) : null}

      {paused ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
          <Pause className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">
            Приём приостановлен — аккаунт остаётся в сети, но новые сообщения не
            собираются.
          </span>
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isPersonal ? (
            <SessionBadge status={channel.sessionStatus} />
          ) : (
            <StatusBadge status={channel.status} />
          )}
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

      {isPersonal ? (
        <ReconnectDialog
          channel={channel}
          open={reconnectOpen}
          onOpenChange={setReconnectOpen}
        />
      ) : null}

      <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Выйти из {channel.name}?</DialogTitle>
            <DialogDescription>
              Это завершит активную сессию и отвяжет аккаунт от воркера.
              Потребуется переподключение (и повторный ввод кода), чтобы вернуть
              его в сеть. История диалогов сохранится.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLogout(false)}>
              Отмена
            </Button>
            <Button onClick={logout} disabled={pending}>
              Выйти
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Удалить канал?</DialogTitle>
            <DialogDescription>
              Это выполнит выход и отключит {channel.name}. Его зашифрованная
              сессия будет удалена. Вы сможете переподключить его позже.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Отмена
            </Button>
            <Button variant="destructive" onClick={remove} disabled={pending}>
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
