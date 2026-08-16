'use client'

import Link from 'next/link'
import {
  ChevronLeft,
  Loader2,
  MessagesSquare,
  Plus,
  Radio,
  Search,
} from 'lucide-react'
import type { ConversationWithManager } from '@/app/actions/admin-secret'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { TYPE_LABEL, fmtTime, initials } from './utils'
import { NotifyButton } from './notify-button'
import { parseReply } from './reply'

/**
 * Left pane of the god messenger: header (live indicator, notifications, new
 * chat), search box and the conversation list with god-side unread badges.
 * Extracted verbatim from god-messenger.tsx.
 */
export function ChatListPane({
  showThread,
  live,
  pushAvailable,
  search,
  onSearchChange,
  loadingList,
  conversations,
  selectedId,
  onSelect,
  onCreate,
  managerNameOf,
}: {
  showThread: boolean
  live: boolean
  pushAvailable: boolean
  search: string
  onSearchChange: (value: string) => void
  loadingList: boolean
  conversations: ConversationWithManager[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  managerNameOf: (id: string | null) => string
}) {
  return (
    <aside
      className={cn(
        'flex w-full shrink-0 flex-col border-r border-border md:w-80 lg:w-96',
        showThread ? 'hidden md:flex' : 'flex',
      )}
    >
      <header className="border-b border-border bg-card/40 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          href="/wijegniwjgwjog"
          className="mb-2.5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          К панели
        </Link>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div
              className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
              aria-hidden="true"
            >
              <MessagesSquare className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold leading-none tracking-tight">
                Мессенджер
              </h1>
              <span
                className={cn(
                  'mt-1.5 inline-flex items-center gap-1 text-xs',
                  live ? 'text-success' : 'text-muted-foreground',
                )}
              >
                <Radio className={cn('size-3', live && 'animate-pulse')} />
                {live ? 'В сети' : 'Подключение…'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <NotifyButton available={pushAvailable} />
            <Button
              size="icon"
              className="size-10 rounded-xl"
              onClick={onCreate}
              aria-label="Новый диалог"
            >
              <Plus className="size-5" />
            </Button>
          </div>
        </div>
      </header>

      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Поиск диалога"
            className="h-11 rounded-xl pl-9 text-base md:text-sm"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loadingList ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <MessagesSquare className="size-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Диалогов нет. Создайте новый, чтобы начать переписку.
            </p>
            <Button size="sm" className="gap-1.5" onClick={onCreate}>
              <Plus className="size-4" /> Новый диалог
            </Button>
          </div>
        ) : (
          <ul className="space-y-0.5 p-2">
            {conversations.map((c) => (
              // content-visibility: the browser skips layout/paint for
              // rows outside the viewport — keeps the list instant even
              // with hundreds of dialogs. intrinsic-size ≈ row height so
              // the scrollbar stays stable.
              <li
                key={c.id}
                style={{
                  contentVisibility: 'auto',
                  containIntrinsicSize: 'auto 68px',
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-muted/60 active:bg-muted',
                    c.id === selectedId
                      ? 'bg-primary/10 ring-1 ring-inset ring-primary/20'
                      : 'bg-transparent',
                  )}
                >
                  <Avatar
                    className={cn(
                      'size-12 shrink-0',
                      (c.godUnread ?? 0) > 0 &&
                        'ring-2 ring-primary ring-offset-2 ring-offset-background',
                    )}
                  >
                    <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                      {initials(c.contactName || c.contactHandle)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          'truncate text-sm',
                          (c.godUnread ?? 0) > 0
                            ? 'font-semibold'
                            : 'font-medium',
                        )}
                      >
                        {c.contactName || c.contactHandle}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 text-[11px]',
                          (c.godUnread ?? 0) > 0
                            ? 'font-medium text-primary'
                            : 'text-muted-foreground',
                        )}
                      >
                        {c.lastMessageAt ? fmtTime(c.lastMessageAt) : ''}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          'truncate text-xs',
                          (c.godUnread ?? 0) > 0
                            ? 'font-medium text-foreground'
                            : 'text-muted-foreground',
                        )}
                      >
                        {parseReply(c.lastMessage || '').text || 'Нет сообщений'}
                      </span>
                      {/* Telegram semantics: the badge counts what YOU (the
                          god user, писавший от имени клиента) haven't read
                          yet — i.e. manager replies newer than your last
                          visit. NOT `unread`, which is the manager-side
                          counter and lights up after your own messages. */}
                      {(c.godUnread ?? 0) > 0 && (
                        <Badge
                          className="h-5 min-w-5 shrink-0 justify-center rounded-full bg-primary px-1.5 text-[11px] tabular-nums text-primary-foreground"
                          title="Непрочитанные сообщения от менеджера"
                        >
                          {c.godUnread}
                        </Badge>
                      )}
                    </div>
                    <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {TYPE_LABEL[c.channelType] ?? c.channelType} ·{' '}
                      {managerNameOf(c.managerId)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
