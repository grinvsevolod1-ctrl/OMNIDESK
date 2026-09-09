'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Flame,
  Layers,
  Loader2,
  MessageCircle,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
import { RenameDialog, SettingsDialog, StartDialog } from './account-dialogs'

const STATUS_META: Record<string, { label: string; dot: string }> = {
  online: { label: 'В сети', dot: 'bg-success' },
  starting: { label: 'Подключение…', dot: 'bg-warning animate-pulse' },
  waiting_qr: { label: 'Ожидает QR', dot: 'bg-sky-500 animate-pulse' },
  waiting_code: { label: 'Ожидает код', dot: 'bg-sky-500 animate-pulse' },
  waiting_password: { label: 'Ожидает 2FA', dot: 'bg-sky-500 animate-pulse' },
  offline: { label: 'Не в сети', dot: 'bg-muted-foreground/50' },
  error: { label: 'Ошибка', dot: 'bg-destructive' },
}

/** Аккаунтов на странице (пагинация списка). */
const PAGE_SIZE = 12

/** online-аккаунты идут первыми, дальше по алфавиту — самое полезное сверху. */
function sortAccounts(list: PersonalAccountItem[]): PersonalAccountItem[] {
  return [...list].sort((a, b) => {
    const aOn = a.sessionStatus === 'online' ? 0 : 1
    const bOn = b.sessionStatus === 'online' ? 0 : 1
    if (aOn !== bOn) return aOn - bOn
    return a.name.localeCompare(b.name, 'ru')
  })
}

/**
 * Список личных аккаунтов: карточка = аккаунт, клик по карточке открывает
 * мессенджер (когда аккаунт в сети). Управление жизненным циклом
 * (стоп/старт/удалить) — в меню карточки. Есть поиск, сводка и пагинация.
 */
export function AccountsList({
  accounts,
  unread,
  onOpen,
  onOpenPool,
  onRefresh,
  refreshing,
}: {
  accounts: PersonalAccountItem[]
  /** id аккаунта -> непрочитанных всего (бейдж на карточке). */
  unread: Record<string, number>
  onOpen: (account: PersonalAccountItem) => void
  /** Открыть общий пул — чаты всех аккаунтов в одном списке. */
  onOpenPool: () => void
  onRefresh: () => void
  refreshing: boolean
}) {
  const [connectOpen, setConnectOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<PersonalAccountItem | null>(null)
  const [settingsFor, setSettingsFor] = useState<PersonalAccountItem | null>(null)
  const [writingFor, setWritingFor] = useState<PersonalAccountItem | null>(null)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [, startTransition] = useTransition()

  const online = accounts.filter((a) => a.sessionStatus === 'online').length

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const base = needle
      ? accounts.filter(
          (a) =>
            a.name.toLowerCase().includes(needle) ||
            (a.phone ?? '').toLowerCase().includes(needle) ||
            (a.detail ?? '').toLowerCase().includes(needle),
        )
      : accounts
    return sortAccounts(base)
  }, [accounts, q])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  // Клэмпим страницу: список мог сократиться (поиск/удаление) под текущей.
  const safePage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  )

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Telegram</h2>
          <p className="text-sm text-muted-foreground text-pretty">
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
          {online > 0 && (
            <Button variant="secondary" onClick={onOpenPool}>
              <Layers className="size-4" />
              Все чаты
            </Button>
          )}
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
        <>
          {/* Сводка + подсказка про автопрогрев */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1">
              <span className="font-semibold tabular-nums">{accounts.length}</span>
              <span className="text-muted-foreground">всего</span>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1">
              <span className="size-2 rounded-full bg-emerald-500" />
              <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {online}
              </span>
              <span className="text-muted-foreground">в сети</span>
            </span>
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-muted-foreground"
              title="Аккаунты в сети автоматически поддерживаются активными: периодически появляются онлайн и читают ленту. Ничего не рассылается."
            >
              <Flame className="size-3.5 text-amber-500" />
              Автопрогрев включён
            </span>
          </div>

          {/* Поиск */}
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(0)
              }}
              placeholder="Поиск по имени или номеру"
              className="pl-8"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pageItems.map((a) => {
              const meta = STATUS_META[a.sessionStatus] ?? STATUS_META.offline
              const busy = busyId === a.id
              const isOnline = a.sessionStatus === 'online'
              const unreadCount = unread[a.id] ?? 0
              const open = () => {
                if (isOnline) onOpen(a)
              }
              return (
                <Card
                  key={a.id}
                  role={isOnline ? 'button' : undefined}
                  tabIndex={isOnline ? 0 : undefined}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (isOnline && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      open()
                    }
                  }}
                  className={cn(
                    'flex flex-col gap-3 p-4 transition-colors',
                    isOnline
                      ? 'cursor-pointer hover:border-primary/40 hover:bg-muted/40'
                      : 'opacity-90',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{a.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {a.phone ?? a.detail ?? '—'}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {unreadCount > 0 && (
                        <span
                          className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground"
                          aria-label={`${unreadCount} непрочитанных`}
                        >
                          {unreadCount > 99 ? '99+' : unreadCount}
                        </span>
                      )}
                      {/* Меню не должно открывать чаты — гасим всплытие клика. */}
                      <div
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
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
                            {isOnline ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  run(a.id, () => personalStopAction(a.id))
                                }
                              >
                                <Pause className="size-4" />
                                Отключить
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onClick={() =>
                                  run(a.id, () => personalStartAction(a.id))
                                }
                              >
                                <Play className="size-4" />
                                Подключить
                              </DropdownMenuItem>
                            )}
                            {isOnline && (
                              <>
                                <DropdownMenuItem onClick={() => setWritingFor(a)}>
                                  <Send className="size-4" />
                                  Написать первым
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => setSettingsFor(a)}
                                >
                                  <Settings2 className="size-4" />
                                  Настройки Telegram
                                </DropdownMenuItem>
                              </>
                            )}
                            <DropdownMenuItem onClick={() => setRenaming(a)}>
                              <Pencil className="size-4" />
                              Переименовать в панели
                            </DropdownMenuItem>
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
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} />
                      {meta.label}
                      {a.sessionStatus === 'error' && a.lastError && (
                        <span className="truncate" title={a.lastError}>
                          — {a.lastError}
                        </span>
                      )}
                    </div>
                    {isOnline ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                        <MessageCircle className="size-3.5" />
                        Открыть
                      </span>
                    ) : null}
                  </div>
                </Card>
              )
            })}
          </div>

          {filtered.length === 0 ? (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              Ничего не найдено по запросу «{q}».
            </Card>
          ) : null}

          {/* Пагинация */}
          {pageCount > 1 ? (
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="gap-1"
              >
                <ChevronLeft className="size-4" />
                Назад
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
                className="gap-1"
              >
                Вперёд
                <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : null}
        </>
      )}

      <AccountConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={onRefresh}
      />

      <RenameDialog
        key={renaming?.id ?? 'closed'}
        account={renaming}
        onOpenChange={(open) => {
          if (!open) setRenaming(null)
        }}
        onRenamed={onRefresh}
      />

      <SettingsDialog
        key={settingsFor ? `s-${settingsFor.id}` : 's-closed'}
        account={settingsFor}
        onOpenChange={(open) => {
          if (!open) setSettingsFor(null)
        }}
        onSaved={onRefresh}
      />

      <StartDialog
        key={writingFor ? `w-${writingFor.id}` : 'w-closed'}
        account={writingFor}
        onOpenChange={(open) => {
          if (!open) setWritingFor(null)
        }}
        onStarted={(account) => onOpen(account)}
      />
    </div>
  )
}
