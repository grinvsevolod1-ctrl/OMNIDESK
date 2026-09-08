'use client'

/**
 * Левая колонка общего пула Telegram (god-панель, вкладка «Telegram»):
 * рельса-фильтр аккаунтов, поиск и единый список диалогов ВСЕХ личных
 * аккаунтов. Каждая строка помечена аккаунтом-владельцем, чтобы всегда было
 * понятно «кто/где». Часть god-панели — инварианты AGENTS.md §4.
 */

import {
  ArrowLeft,
  Layers,
  Loader2,
  MoreVertical,
  Search,
  Trash2,
} from 'lucide-react'
import type {
  PooledAccount,
  PooledDialog,
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
import { DialogAvatar, accountHue, formatDialogTime } from './messenger-shared'

/** Компактный бейдж непрочитанных. */
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
      {count > 99 ? '99+' : count}
    </span>
  )
}

export function DialogList({
  accounts,
  unread,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  dialogs,
  loading,
  error,
  selectedAccountId,
  selectedPeerId,
  onSelect,
  onDeleteDialog,
  onBack,
  peerOpen,
}: {
  /** Все личные аккаунты (offline тоже — показываются приглушённо). */
  accounts: PooledAccount[]
  /** id аккаунта -> непрочитанных всего. */
  unread: Record<string, number>
  /** 'all' или id аккаунта. */
  filter: string
  onFilterChange: (v: string) => void
  search: string
  onSearchChange: (v: string) => void
  /** Уже отфильтрованные (по аккаунту + поиску) диалоги пула. */
  dialogs: PooledDialog[]
  loading: boolean
  error: string | null
  selectedAccountId: string | null
  selectedPeerId: string | null
  onSelect: (dialog: PooledDialog) => void
  onDeleteDialog: (accountId: string, peerId: string, revoke: boolean) => void
  onBack: () => void
  /** true когда открыт тред — на мобиле список тогда прячется. */
  peerOpen: boolean
}) {
  const totalUnread = accounts.reduce((s, a) => s + (unread[a.id] ?? 0), 0)
  const showAccountTag = filter === 'all'
  const activeAccount =
    filter === 'all' ? null : accounts.find((a) => a.id === filter) ?? null

  return (
    <aside
      className={cn(
        'flex w-full shrink-0 border-r border-border md:w-[26rem]',
        peerOpen && 'hidden md:flex',
      )}
    >
      {/* Рельса-фильтр аккаунтов: «Все» + каждый профиль. */}
      <div className="flex w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-muted/40 py-3">
        <button
          type="button"
          onClick={() => onFilterChange('all')}
          title="Все чаты"
          aria-label="Все чаты"
          aria-current={filter === 'all' ? 'true' : undefined}
          className={cn(
            'relative flex size-11 shrink-0 items-center justify-center rounded-2xl transition-all',
            filter === 'all'
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-foreground shadow-sm ring-1 ring-border hover:ring-primary/50',
          )}
        >
          <Layers className="size-5" />
          {totalUnread > 0 && filter !== 'all' && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {totalUnread > 99 ? '99+' : totalUnread}
            </span>
          )}
        </button>
        <span className="mb-1 text-[10px] font-medium text-muted-foreground">
          Все
        </span>

        {accounts.map((a) => {
          const active = filter === a.id
          const count = unread[a.id] ?? 0
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onFilterChange(a.id)}
              title={`${a.name}${a.online ? '' : ' (не в сети)'}`}
              aria-label={`Аккаунт ${a.name}`}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'relative flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-all',
                a.online
                  ? cn('text-white shadow-sm hover:brightness-110', accountHue(a.id))
                  : 'bg-muted text-muted-foreground/50',
                active && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
              )}
            >
              {a.name.slice(0, 1).toUpperCase()}
              {a.online && (
                <span
                  className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-background bg-emerald-500"
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

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Шапка: контекст (где я нахожусь). */}
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
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {activeAccount ? (
              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white',
                  accountHue(activeAccount.id),
                )}
              >
                {activeAccount.name.slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Layers className="size-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {activeAccount ? activeAccount.name : 'Все чаты'}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {activeAccount
                  ? activeAccount.online
                    ? 'Личный аккаунт · в сети'
                    : 'Личный аккаунт · не в сети'
                  : `${accounts.filter((a) => a.online).length} аккаунтов в сети`}
              </p>
            </div>
          </div>
        </div>

        {/* Поиск. */}
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={
                filter === 'all' ? 'Поиск по всем чатам' : 'Поиск диалогов'
              }
              className="h-9 pl-8"
            />
          </div>
        </div>

        {/* Список. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && dialogs.length === 0 ? (
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
            dialogs.map((d) => {
              const active =
                selectedAccountId === d.accountId && selectedPeerId === d.peerId
              return (
                <div
                  key={`${d.accountId}:${d.peerId}`}
                  className="group/dialog relative"
                >
                  <button
                    type="button"
                    onClick={() => onSelect(d)}
                    className={cn(
                      'flex w-full items-center gap-3 border-l-2 border-transparent px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                      active && 'border-primary bg-muted',
                    )}
                  >
                    <div className="relative shrink-0">
                      <DialogAvatar channelId={d.accountId} dialog={d} />
                      {showAccountTag && (
                        <span
                          className={cn(
                            'absolute -bottom-0.5 -right-0.5 size-4 rounded-full border-2 border-card',
                            accountHue(d.accountId),
                          )}
                          aria-hidden
                          title={d.accountName}
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm font-medium">{d.title}</p>
                        <span className="shrink-0 text-[11px] text-muted-foreground transition-opacity group-hover/dialog:opacity-0">
                          {formatDialogTime(d.lastMessageAt)}
                        </span>
                      </div>
                      {showAccountTag && (
                        <div className="mb-0.5 flex items-center gap-1">
                          <span
                            className={cn(
                              'size-1.5 rounded-full',
                              accountHue(d.accountId),
                            )}
                            aria-hidden
                          />
                          <span className="truncate text-[11px] font-medium text-muted-foreground">
                            {d.accountName}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs text-muted-foreground">
                          {d.lastOutgoing && (
                            <span className="mr-1 text-muted-foreground/70">
                              Вы:
                            </span>
                          )}
                          {d.lastMessage || '—'}
                        </p>
                        <UnreadBadge count={d.unreadCount} />
                      </div>
                    </div>
                  </button>

                  {/* Меню диалога. */}
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
                                onDeleteDialog(d.accountId, d.peerId, false)
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
                                onDeleteDialog(d.accountId, d.peerId, true)
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
                            if (
                              confirm(`Покинуть «${d.title}» и удалить из списка?`)
                            ) {
                              onDeleteDialog(d.accountId, d.peerId, false)
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
              )
            })
          )}
        </div>
      </div>
    </aside>
  )
}
