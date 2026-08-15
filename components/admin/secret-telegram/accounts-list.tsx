'use client'

import { useState, useTransition } from 'react'
import {
  Loader2,
  MessageCircle,
  MoreVertical,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  personalDeleteAction,
  personalStartAction,
  personalStopAction,
  type PersonalAccountItem,
} from '@/app/actions/admin-secret/telegram-personal'
import { AccountConnectDialog } from './account-connect'

const STATUS_META: Record<
  string,
  { label: string; dot: string }
> = {
  online: { label: 'В сети', dot: 'bg-emerald-500' },
  starting: { label: 'Подключение…', dot: 'bg-amber-500 animate-pulse' },
  waiting_qr: { label: 'Ожидает QR', dot: 'bg-sky-500 animate-pulse' },
  waiting_code: { label: 'Ожидает код', dot: 'bg-sky-500 animate-pulse' },
  waiting_password: { label: 'Ожидает 2FA', dot: 'bg-sky-500 animate-pulse' },
  offline: { label: 'Не в сети', dot: 'bg-muted-foreground/50' },
  error: { label: 'Ошибка', dot: 'bg-destructive' },
}

/**
 * Список личных аккаунтов: карточка = аккаунт, клик — открыть мессенджер.
 * Управление жизненным циклом (стоп/старт/удалить) — в меню карточки.
 */
export function AccountsList({
  accounts,
  onOpen,
  onRefresh,
  refreshing,
}: {
  accounts: PersonalAccountItem[]
  onOpen: (account: PersonalAccountItem) => void
  onRefresh: () => void
  refreshing: boolean
}) {
  const [connectOpen, setConnectOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const run = (id: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusyId(id)
    startTransition(async () => {
      const res = await fn()
      setBusyId(null)
      if (res.ok) {
        toast.success(res.message)
        onRefresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Telegram</h2>
          <p className="text-sm text-muted-foreground">
            Личные аккаунты — переписка читается напрямую из Telegram и нигде
            не сохраняется.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-9 bg-transparent"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Обновить"
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
          <Button onClick={() => setConnectOpen(true)}>
            <Plus className="size-4" />
            Подключить
          </Button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <Card className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <MessageCircle className="size-6 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium">Нет подключённых аккаунтов</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground text-pretty">
              Подключите личный Telegram-аккаунт по QR-коду или номеру
              телефона, чтобы общаться прямо отсюда.
            </p>
          </div>
          <Button onClick={() => setConnectOpen(true)}>
            <Plus className="size-4" />
            Подключить аккаунт
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((a) => {
            const meta = STATUS_META[a.sessionStatus] ?? STATUS_META.offline
            const busy = busyId === a.id
            return (
              <Card key={a.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{a.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.phone ?? a.detail ?? '—'}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          aria-label="Действия"
                          disabled={busy}
                        >
                          {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <MoreVertical className="size-4" />
                          )}
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      {a.sessionStatus === 'online' ? (
                        <DropdownMenuItem
                          onClick={() => run(a.id, () => personalStopAction(a.id))}
                        >
                          <Pause className="size-4" />
                          Отключить
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onClick={() => run(a.id, () => personalStartAction(a.id))}
                        >
                          <Play className="size-4" />
                          Подключить
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          if (
                            confirm(
                              'Удалить аккаунт из панели? Авторизация в Telegram будет завершена.',
                            )
                          ) {
                            run(a.id, () => personalDeleteAction(a.id))
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                        Удалить
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={cn('size-2 rounded-full', meta.dot)} />
                  {meta.label}
                  {a.sessionStatus === 'error' && a.lastError && (
                    <span className="truncate" title={a.lastError}>
                      — {a.lastError}
                    </span>
                  )}
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={a.sessionStatus !== 'online'}
                  onClick={() => onOpen(a)}
                >
                  <MessageCircle className="size-4" />
                  Открыть чаты
                </Button>
              </Card>
            )
          })}
        </div>
      )}

      <AccountConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={onRefresh}
      />
    </div>
  )
}
