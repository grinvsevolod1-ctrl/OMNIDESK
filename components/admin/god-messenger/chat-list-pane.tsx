'use client'

import { memo } from 'react'
import Link from 'next/link'
import {
  ChevronLeft,
  Loader2,
  MessagesSquare,
  Plus,
  Search,
} from 'lucide-react'
import type { ConversationWithManager } from '@/app/actions/admin-secret'
import { ContactAvatar, Highlight } from '@/components/manager/inbox/atoms'
import { SourceChip } from '@/components/manager/inbox/atoms'
import { listStamp } from '@/components/manager/inbox/visual'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { NotifyButton } from './notify-button'
import { parseReply } from './reply'

/**
 * Left pane of the god messenger. Visual language mirrors the MANAGER inbox
 * (same avatar-with-platform-badge, same row anatomy, same source chip and
 * unread badge), adapted to the god structure: the third row shows the
 * assigned manager instead of a lead status, and the unread counter is
 * godUnread (manager replies the god user hasn't seen) — not the
 * manager-side `unread`.
 */
export const ChatListPane = memo(function ChatListPane({
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
        'flex w-full shrink-0 flex-col border-r border-border md:w-[340px]',
        showThread ? 'hidden md:flex' : 'flex',
      )}
    >
      <header className="border-b border-border px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          href="/wijegniwjgwjog"
          className="mb-2.5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          К панели
        </Link>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-none tracking-tight">
              Мессенджер
            </h1>
            {/* Live-индикатор в языке менеджерского SyncBadge: пульсирующая
                точка + подпись, без рамок и подложек. */}
            <span
              className={cn(
                'mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium',
                live
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400',
              )}
              role="status"
              aria-live="polite"
            >
              <span className="relative flex size-2">
                <span
                  className={cn(
                    'absolute inline-flex size-full animate-ping rounded-full opacity-60',
                    live ? 'bg-emerald-500' : 'bg-amber-500',
                  )}
                  aria-hidden
                />
                <span
                  className={cn(
                    'relative inline-flex size-2 rounded-full',
                    live ? 'bg-emerald-500' : 'bg-amber-500',
                  )}
                  aria-hidden
                />
              </span>
              {live ? 'Онлайн' : 'Подключение'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <NotifyButton available={pushAvailable} />
            <Button
              size="icon"
              className="size-9 rounded-lg"
              onClick={onCreate}
              aria-label="Новый диалог"
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </div>
        <div className="relative mt-3">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Поиск диалога"
            className="h-9 rounded-lg pl-9 text-base md:text-sm"
          />
        </div>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5">
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
          <ul>
            {conversations.map((c) => {
              const unread = c.godUnread ?? 0
              return (
                // content-visibility: the browser skips layout/paint for
                // rows outside the viewport — keeps the list instant even
                // with hundreds of dialogs.
                <li
                  key={c.id}
                  style={{
                    contentVisibility: 'auto',
                    containIntrinsicSize: 'auto 76px',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-[background-color,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-muted/60 active:scale-[0.985]',
                      c.id === selectedId ? 'bg-secondary hover:bg-secondary' : '',
                    )}
                  >
                    <ContactAvatar
                      name={c.contactName || c.contactHandle}
                      channel={c.channelType}
                      channelId={c.channelId}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p
                          className={cn(
                            'flex min-w-0 items-center gap-1 truncate text-sm',
                            unread > 0 ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          <Highlight
                            text={c.contactName || c.contactHandle}
                            query={search}
                          />
                          {c.contactUsername ? (
                            <span className="shrink-0 truncate text-[11px] font-normal text-muted-foreground">
                              @{c.contactUsername}
                            </span>
                          ) : null}
                        </p>
                        <span
                          className={cn(
                            'shrink-0 text-[11px]',
                            unread > 0
                              ? 'font-medium text-primary'
                              : 'text-muted-foreground',
                          )}
                        >
                          {c.lastMessageAt ? listStamp(c.lastMessageAt) : ''}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <p
                          className={cn(
                            'truncate text-xs',
                            unread > 0
                              ? 'text-foreground/80'
                              : 'text-muted-foreground',
                          )}
                        >
                          {parseReply(c.lastMessage || '').text ||
                            'Нет сообщений'}
                        </p>
                        {/* Telegram semantics: counts what YOU (писавший от
                            имени клиента) haven't read — manager replies
                            newer than your last visit. NOT `unread`. */}
                        {unread > 0 && (
                          <span
                            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground"
                            title="Непрочитанные сообщения от менеджера"
                          >
                            {unread}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="truncate text-[10px] text-muted-foreground">
                          {managerNameOf(c.managerId)}
                        </span>
                        <SourceChip
                          conversation={c}
                          size="xs"
                          className="ml-auto max-w-[45%]"
                        />
                      </div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
})
