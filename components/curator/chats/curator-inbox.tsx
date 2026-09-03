'use client'

/**
 * Раздел «Чаты» куратора: список переданных диалогов + тред + композер
 * (текст и фото/файл). Намеренно проще менеджерского инбокса — куратор только
 * ведёт переписку по переданным лидам, без реакций/пересылки/стикеров/статусов.
 * Переиспользуем чистые презентационные атомы менеджера (ContactAvatar,
 * SourceChip, MessageMedia, DeliveryTicks, visual-хелперы), но НЕ его
 * состояние — логика в use-curator-chats.
 */

import { useMemo, useRef, useState } from 'react'
import { ArrowLeft, MessageCircle, Paperclip, Search, SendHorizonal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Conversation, Message } from '@/lib/types'
import {
  ContactAvatar,
  DeliveryTicks,
  SourceChip,
} from '@/components/manager/inbox/atoms'
import {
  isMediaPlaceholder,
  MessageMedia,
} from '@/components/manager/inbox/message-media'
import { dayLabel, timeShort } from '@/components/manager/inbox/visual'
import { useCuratorChats } from '@/components/curator/chats/use-curator-chats'

export function CuratorInbox({
  conversations,
  messagesByConversation,
  currentUser,
}: {
  conversations: Conversation[]
  messagesByConversation: Record<string, Message[]>
  currentUser: string
}) {
  const {
    activeId,
    setActiveId,
    active,
    thread,
    threadLoading,
    loadingOlder,
    noOlder,
    loadOlder,
    handleSend,
    handleSendMediaFile,
    pending,
  } = useCuratorChats({ conversations, messagesByConversation, currentUser })

  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(
      (c) =>
        c.contactName.toLowerCase().includes(q) ||
        (c.lastMessage ?? '').toLowerCase().includes(q),
    )
  }, [conversations, search])

  return (
    <div className="flex h-[calc(100vh-8rem)] overflow-hidden rounded-xl border border-border bg-card">
      {/* Список диалогов */}
      <aside
        className={cn(
          'flex w-full flex-col border-r border-border md:w-80 lg:w-96',
          activeId ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по диалогам…"
              className="pl-9"
              aria-label="Поиск по диалогам"
            />
          </div>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {conversations.length === 0
                ? 'Переданных диалогов пока нет. Когда вам передадут лид с перепиской, он появится здесь.'
                : 'Ничего не найдено.'}
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(c.id)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50',
                      activeId === c.id && 'bg-muted',
                    )}
                  >
                    <ContactAvatar
                      name={c.contactName}
                      channel={c.channelType}
                      channelId={c.channelId}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {c.contactName}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {timeShort(c.lastMessageAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <SourceChip conversation={c} size="xs" />
                        <span className="truncate text-xs text-muted-foreground">
                          {c.lastMessage || '—'}
                        </span>
                      </div>
                    </div>
                    {c.unread > 0 ? (
                      <span className="ml-1 shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground tabular-nums">
                        {c.unread}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Тред */}
      <section
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          activeId ? 'flex' : 'hidden md:flex',
        )}
      >
        {active ? (
          <CuratorThread
            active={active}
            thread={thread}
            threadLoading={threadLoading}
            loadingOlder={loadingOlder}
            noOlder={Boolean(activeId && noOlder[activeId])}
            onLoadOlder={loadOlder}
            onBack={() => setActiveId(null)}
            onSend={handleSend}
            onSendMediaFile={handleSendMediaFile}
            pending={pending}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <MessageCircle className="size-10 opacity-40" />
            <p className="text-sm">Выберите диалог слева</p>
          </div>
        )}
      </section>
    </div>
  )
}

function CuratorThread({
  active,
  thread,
  threadLoading,
  loadingOlder,
  noOlder,
  onLoadOlder,
  onBack,
  onSend,
  onSendMediaFile,
  pending,
}: {
  active: Conversation
  thread: Message[]
  threadLoading: boolean
  loadingOlder: boolean
  noOlder: boolean
  onLoadOlder: () => void
  onBack: () => void
  onSend: (text: string) => void
  onSendMediaFile: (file: File, caption: string) => void
  pending: boolean
}) {
  const canAttach =
    active.channelType === 'whatsapp' || active.channelType === 'vk'

  return (
    <>
      {/* Шапка треда */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onBack}
          aria-label="Назад к списку"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <ContactAvatar
          name={active.contactName}
          channel={active.channelType}
          channelId={active.channelId}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {active.contactName}
          </div>
          <SourceChip conversation={active} size="xs" />
        </div>
      </header>

      {/* Лента сообщений */}
      <div className="scrollbar-thin flex-1 overflow-y-auto bg-muted/20 px-4 py-4">
        {!noOlder && thread.length > 0 ? (
          <div className="mb-3 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={onLoadOlder}
              disabled={loadingOlder}
            >
              {loadingOlder ? 'Загрузка…' : 'Показать историю'}
            </Button>
          </div>
        ) : null}

        {threadLoading && thread.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Загрузка переписки…
          </div>
        ) : thread.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Сообщений пока нет.
          </div>
        ) : (
          <CuratorMessages thread={thread} />
        )}
      </div>

      {/* Композер: текст + (для WhatsApp/VK) вложение */}
      <CuratorComposer
        canAttach={canAttach}
        pending={pending}
        onSend={onSend}
        onSendMediaFile={onSendMediaFile}
      />
    </>
  )
}

function CuratorMessages({ thread }: { thread: Message[] }) {
  // Разделители по дням + баблы. Группировку по дню считаем на лету.
  let lastDay = ''
  return (
    <div className="flex flex-col gap-1.5">
      {thread.map((m) => {
        const day = dayLabel(m.createdAt)
        const showDay = day !== lastDay
        lastDay = day
        const out = m.direction === 'out'
        const deleted = Boolean(m.deletedAt)
        const hasMedia = Boolean(m.mediaType)
        const showBody =
          m.body && !(hasMedia && isMediaPlaceholder(m.body)) && !deleted
        return (
          <div key={m.id}>
            {showDay ? (
              <div className="my-3 flex justify-center">
                <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
                  {day}
                </span>
              </div>
            ) : null}
            <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                  out
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-foreground border border-border',
                )}
              >
                {deleted ? (
                  <span className="italic opacity-70">Сообщение удалено</span>
                ) : (
                  <>
                    {hasMedia ? <MessageMedia message={m} /> : null}
                    {showBody ? (
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    ) : null}
                    <div
                      className={cn(
                        'mt-0.5 flex items-center justify-end gap-1 text-[10px]',
                        out
                          ? 'text-primary-foreground/70'
                          : 'text-muted-foreground',
                      )}
                    >
                      <span>{timeShort(m.createdAt)}</span>
                      {out ? <DeliveryTicks status={m.status} /> : null}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CuratorComposer({
  canAttach,
  pending,
  onSend,
  onSendMediaFile,
}: {
  canAttach: boolean
  pending: boolean
  onSend: (text: string) => void
  onSendMediaFile: (file: File, caption: string) => void
}) {
  const [text, setText] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  function submit() {
    const body = text.trim()
    if (!body) return
    onSend(body)
    setText('')
  }

  return (
    <form
      className="flex items-end gap-1.5 border-t border-border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {canAttach ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) {
                onSendMediaFile(f, text.trim())
                setText('')
              }
              e.target.value = ''
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            disabled={pending}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Прикрепить файл"
            title="Прикрепить файл (фото, документ)"
          >
            <Paperclip className="size-4" />
          </Button>
        </>
      ) : null}
      <textarea
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Написать сообщение…"
        aria-label="Текст ответа"
        className="scrollbar-thin max-h-40 min-h-[40px] flex-1 resize-none rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/30"
      />
      <Button
        type="submit"
        size="icon"
        className="size-10 shrink-0 rounded-full"
        disabled={pending || !text.trim()}
        aria-label="Отправить"
      >
        <SendHorizonal className="size-4" />
      </Button>
    </form>
  )
}
