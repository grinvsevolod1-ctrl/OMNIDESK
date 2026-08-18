'use client'

/**
 * Левая колонка личного мессенджера (god-панель, вкладка «Telegram»): шапка
 * аккаунта, поиск и список диалогов. Вынесено из personal-messenger.tsx.
 * Часть god-панели — инварианты AGENTS.md §4.
 */

import {
  ArrowLeft,
  Check,
  ChevronsUpDown,
  Loader2,
  MoreVertical,
  Search,
  Trash2,
} from 'lucide-react'
import type {
  PersonalAccountItem,
  PersonalDialog,
} from '@/app/actions/admin-secret/telegram-personal'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { DialogAvatar, formatDialogTime } from './messenger-shared'

/** Компактный бейдж непрочитанных (одинаковый в свитчере и списке). */
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
      {count > 99 ? '99+' : count}
    </span>
  )
}

export function DialogList({
  channelId,
  accountName,
  accounts,
  unread,
  onSwitchAccount,
  onBack,
  search,
  onSearchChange,
  dialogs,
  loading,
  error,
  activePeer,
  onSelectPeer,
  onDeleteDialog,
  /** true when a peer thread is open — the list hides on mobile then. */
  peerOpen,
}: {
  channelId: string
  accountName: string
  /** Все личные аккаунты для свитчера (offline показываются disabled). */
  accounts: PersonalAccountItem[]
  /** id аккаунта -> непрочитанных всего. */
  unread: Record<string, number>
  onSwitchAccount: (account: PersonalAccountItem) => void
  onBack: () => void
  search: string
  onSearchChange: (v: string) => void
  dialogs: PersonalDialog[]
  loading: boolean
  error: string | null
  activePeer: string | null
  onSelectPeer: (peerId: string) => void
  onDeleteDialog: (peerId: string, revoke: boolean) => void
  peerOpen: boolean
}) {
  // Непрочитанные на ДРУГИХ аккаунтах — сигнал на свёрнутом триггере.
  const otherUnread = accounts.reduce(
    (s, a) => (a.id === channelId ? s : s + (unread[a.id] ?? 0)),
    0,
  )
  return (
    <aside
      className={cn(
        'flex w-full shrink-0 border-r border-border md:w-96',
        peerOpen && 'hidden md:flex',
      )}
    >
      {/* Рельса аккаунтов (desktop): переключение одним кликом, как в
          Telegram Desktop. На мобиле остаётся дропдаун в шапке. */}
      {accounts.length > 1 && (
        <div className="hidden w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-muted/40 py-3 md:flex">
          {accounts.map((a) => {
            const online = a.sessionStatus === 'online'
            const active = a.id === channelId
            const count = unread[a.id] ?? 0
            return (
              <button
                key={a.id}
                type="button"
                disabled={!online}
                title={`${a.name}${online ? '' : ' (не в сети)'}`}
                onClick={() => {
                  if (!active) onSwitchAccount(a)
                }}
                className={cn(
                  'relative flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-all',
                  active
                    ? 'bg-primary text-primary-foreground ring-2 ring-primary ring-offset-2 ring-offset-background'
                    : online
                      ? 'bg-background text-foreground shadow-sm ring-1 ring-border hover:ring-primary/50'
                      : 'bg-muted text-muted-foreground/50',
                )}
                aria-label={`Аккаунт ${a.name}`}
                aria-current={active ? 'true' : undefined}
              >
                {a.name.slice(0, 1).toUpperCase()}
                {online && !active && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-500"
                    aria-hidden
                  />
                )}
                {count > 0 && !active && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={onBack}
          aria-label="К списку аккаунтов"
        >
          <ArrowLeft className="size-4" />
        </Button>
        {/* Свитчер аккаунтов: все аккаунты в одном меню, с бейджами */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1"
                aria-label="Сменить аккаунт"
              >
                <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                  {accountName.slice(0, 1).toUpperCase()}
                  {otherUnread > 0 && (
                    <span
                      className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-primary"
                      aria-label="Есть непрочитанные на других аккаунтах"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-semibold">
                    {accountName}
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    Личный аккаунт
                  </span>
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-72">
            {accounts.map((a) => {
              const online = a.sessionStatus === 'online'
              const count = unread[a.id] ?? 0
              return (
                <DropdownMenuItem
                  key={a.id}
                  disabled={!online}
                  onClick={() => {
                    if (a.id !== channelId) onSwitchAccount(a)
                  }}
                >
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      online ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{a.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {a.phone ?? (online ? 'В сети' : 'Не в сети')}
                    </span>
                  </span>
                  <UnreadBadge count={count} />
                  {a.id === channelId && (
                    <Check className="size-4 shrink-0 text-primary" />
                  )}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Поиск диалогов"
            className="h-9 pl-8"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : error ? (
          <p className="p-4 text-sm text-muted-foreground">{error}</p>
        ) : dialogs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {search ? 'Ничего не найдено.' : 'Диалогов пока нет.'}
          </p>
        ) : (
          dialogs.map((d) => (
            <div key={d.peerId} className="group/dialog relative">
              <button
                type="button"
                onClick={() => onSelectPeer(d.peerId)}
                className={cn(
                  'flex w-full items-center gap-3 border-l-2 border-transparent px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                  activePeer === d.peerId && 'border-primary bg-muted',
                )}
              >
                <DialogAvatar channelId={channelId} dialog={d} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium">{d.title}</p>
                    <span className="shrink-0 text-[11px] text-muted-foreground transition-opacity group-hover/dialog:opacity-0">
                      {formatDialogTime(d.lastMessageAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs text-muted-foreground">
                      {d.lastOutgoing && (
                        <span className="mr-1 text-muted-foreground/70">Вы:</span>
                      )}
                      {d.lastMessage || '—'}
                    </p>
                    <UnreadBadge count={d.unreadCount} />
                  </div>
                </div>
              </button>
              {/* Меню диалога — появляется на hover поверх времени. */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1.5 top-2 size-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/dialog:opacity-100 data-[popup-open]:opacity-100"
                      aria-label={`Действия с диалогом ${d.title}`}
                    >
                      <MoreVertical className="size-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  {d.kind === 'user' ? (
                    <>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          if (confirm(`Удалить диалог с «${d.title}» у себя?`)) {
                            onDeleteDialog(d.peerId, false)
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                        Удалить у себя
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          if (
                            confirm(
                              `Удалить диалог с «${d.title}» у ОБОИХ участников? Историю будет не вернуть.`,
                            )
                          ) {
                            onDeleteDialog(d.peerId, true)
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                        Удалить у обоих
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => {
                        if (confirm(`Покинуть «${d.title}» и удалить из списка?`)) {
                          onDeleteDialog(d.peerId, false)
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                      Покинуть и удалить
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>
      </div>
    </aside>
  )
}
