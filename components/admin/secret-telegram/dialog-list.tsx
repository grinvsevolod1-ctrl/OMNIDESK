'use client'

/**
 * Левая колонка личного мессенджера (god-панель, вкладка «Telegram»): шапка
 * аккаунта, поиск и список диалогов. Вынесено из personal-messenger.tsx.
 * Часть god-панели — инварианты AGENTS.md §4.
 */

import { ArrowLeft, Loader2, Search } from 'lucide-react'
import type {
  PersonalDialog,
} from '@/app/actions/admin-secret/telegram-personal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { DialogAvatar, formatDialogTime } from './messenger-shared'

export function DialogList({
  channelId,
  accountName,
  onBack,
  search,
  onSearchChange,
  dialogs,
  loading,
  error,
  activePeer,
  onSelectPeer,
  /** true when a peer thread is open — the list hides on mobile then. */
  peerOpen,
}: {
  channelId: string
  accountName: string
  onBack: () => void
  search: string
  onSearchChange: (v: string) => void
  dialogs: PersonalDialog[]
  loading: boolean
  error: string | null
  activePeer: string | null
  onSelectPeer: (peerId: string) => void
  peerOpen: boolean
}) {
  return (
    <aside
      className={cn(
        'flex w-full shrink-0 flex-col border-r border-border md:w-80',
        peerOpen && 'hidden md:flex',
      )}
    >
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
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{accountName}</p>
          <p className="text-xs text-muted-foreground">Личный аккаунт</p>
        </div>
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
            <button
              key={d.peerId}
              type="button"
              onClick={() => onSelectPeer(d.peerId)}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                activePeer === d.peerId && 'bg-muted',
              )}
            >
              <DialogAvatar channelId={channelId} dialog={d} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium">{d.title}</p>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
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
                  {d.unreadCount > 0 && (
                    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                      {d.unreadCount > 99 ? '99+' : d.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </aside>
  )
}
