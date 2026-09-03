'use client'

/**
 * Раздел «Чаты» куратора: список переданных диалогов + тред + композер.
 * Полноэкранная раскладка (dashboard-shell отдаёт /curator/chats как fullBleed,
 * без полей и внешнего скролла — как менеджерский инбокс). Тред переиспользует
 * богатый презентационный MessageList менеджера (баблы, цитаты, реакции-дисплей,
 * медиа, тики, разделители дней, бесконечная подгрузка вверх) в режиме
 * readOnlyActions: куратору доступны только «Ответить» и «Копировать», без
 * провайдер-действий (реакции/пересылка/редактирование/удаление). Состояние —
 * в use-curator-chats, здесь только вёрстка и локальный UI-стейт панелей.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CalendarClock,
  Info,
  MessageCircle,
  Paperclip,
  Radio,
  Reply,
  Search,
  SendHorizonal,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Conversation, Message } from '@/lib/types'
import { LEAD_STATUS_META } from '@/lib/types'
import { ContactAvatar, MetaRows, SourceChip } from '@/components/manager/inbox/atoms'
import { MessageList } from '@/components/manager/inbox/message-list'
import { EmojiPicker } from '@/components/manager/inbox/pickers'
import { CHANNEL_VISUAL, listStamp } from '@/components/manager/inbox/visual'
import { useCuratorChats } from '@/components/curator/chats/use-curator-chats'
import type { PanelChannelType } from '@/lib/types'

type ListFilter = 'all' | 'unread'

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
    replyTarget,
    setReplyTarget,
    handleReply,
    handleCopy,
    pending,
  } = useCuratorChats({ conversations, messagesByConversation, currentUser })

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ListFilter>('all')
  const [infoOpen, setInfoOpen] = useState(false)

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unread || 0), 0),
    [conversations],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return conversations.filter((c) => {
      if (filter === 'unread' && !(c.unread > 0)) return false
      if (!q) return true
      return (
        c.contactName.toLowerCase().includes(q) ||
        (c.contactUsername ?? '').toLowerCase().includes(q) ||
        (c.lastMessage ?? '').toLowerCase().includes(q)
      )
    })
  }, [conversations, search, filter])

  return (
    <div className="relative flex h-full overflow-hidden bg-background">
      {/* ------------------------------- Список ------------------------------ */}
      <aside
        className={cn(
          'flex w-full flex-col border-r border-border bg-card md:w-80 lg:w-[22rem]',
          activeId ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="flex flex-col gap-3 border-b border-border p-3">
          <div className="flex items-center justify-between px-1">
            <h1 className="text-base font-semibold">Чаты</h1>
            <span className="text-xs text-muted-foreground">
              {conversations.length}
              {totalUnread > 0 ? (
                <span className="ml-1 text-primary">· {totalUnread} новых</span>
              ) : null}
            </span>
          </div>
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
          {/* Сегмент-фильтр: все / только непрочитанные */}
          <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
            {(
              [
                ['all', 'Все'],
                ['unread', 'Непрочитанные'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={cn(
                  'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  filter === value
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
                {value === 'unread' && totalUnread > 0 ? (
                  <span className="ml-1 tabular-nums">({totalUnread})</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="scrollbar-thin flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {conversations.length === 0
                ? 'Переданных диалогов пока нет. Когда вам передадут лид с перепиской, он появится здесь.'
                : filter === 'unread'
                  ? 'Непрочитанных диалогов нет.'
                  : 'Ничего не найдено.'}
            </div>
          ) : (
            <ul className="p-1.5">
              {filtered.map((c) => {
                const isActive = activeId === c.id
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveId(c.id)
                        setInfoOpen(false)
                      }}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors',
                        isActive
                          ? 'bg-primary/10 ring-1 ring-primary/30'
                          : 'hover:bg-muted/60',
                      )}
                    >
                      <ContactAvatar
                        name={c.contactName}
                        channel={c.channelType}
                        channelId={c.channelId}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'truncate text-sm',
                              c.unread > 0
                                ? 'font-semibold text-foreground'
                                : 'font-medium',
                            )}
                          >
                            {c.contactName}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {listStamp(c.lastMessageAt)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <SourceChip conversation={c} size="xs" />
                          <span
                            className={cn(
                              'truncate text-xs',
                              c.unread > 0
                                ? 'text-foreground/80'
                                : 'text-muted-foreground',
                            )}
                          >
                            {c.lastMessage || '—'}
                          </span>
                        </div>
                      </div>
                      {c.unread > 0 ? (
                        <span className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums">
                          {c.unread > 99 ? '99+' : c.unread}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* -------------------------------- Тред ------------------------------- */}
      <section
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          activeId ? 'flex' : 'hidden md:flex',
        )}
      >
        {active ? (
          <CuratorThread
            key={active.id}
            active={active}
            activeId={activeId}
            thread={thread}
            threadLoading={threadLoading}
            loadingOlder={loadingOlder}
            noOlder={noOlder}
            onLoadOlder={loadOlder}
            onBack={() => setActiveId(null)}
            onSend={handleSend}
            onSendMediaFile={handleSendMediaFile}
            onReply={handleReply}
            onCopy={handleCopy}
            replyTarget={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
            infoOpen={infoOpen}
            onToggleInfo={() => setInfoOpen((v) => !v)}
            pending={pending}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <MessageCircle className="size-10 opacity-40" />
            <p className="text-sm">Выберите диалог слева</p>
          </div>
        )}
      </section>

      {/* --------------------------- Инфо-панель ----------------------------- */}
      {active && infoOpen ? (
        <CuratorInfoPanel active={active} onClose={() => setInfoOpen(false)} />
      ) : null}
    </div>
  )
}

function CuratorThread({
  active,
  activeId,
  thread,
  threadLoading,
  loadingOlder,
  noOlder,
  onLoadOlder,
  onBack,
  onSend,
  onSendMediaFile,
  onReply,
  onCopy,
  replyTarget,
  onCancelReply,
  infoOpen,
  onToggleInfo,
  pending,
}: {
  active: Conversation
  activeId: string | null
  thread: Message[]
  threadLoading: boolean
  loadingOlder: boolean
  noOlder: Record<string, boolean>
  onLoadOlder: () => void
  onBack: () => void
  onSend: (text: string) => void
  onSendMediaFile: (file: File, caption: string) => void
  onReply: (m: Message) => void
  onCopy: (m: Message) => void
  replyTarget: Message | null
  onCancelReply: () => void
  infoOpen: boolean
  onToggleInfo: () => void
  pending: boolean
}) {
  const canAttach =
    active.channelType === 'whatsapp' || active.channelType === 'vk'
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const channelShort =
    CHANNEL_VISUAL[active.channelType as PanelChannelType]?.short ??
    active.channelType

  // Автопрокрутка вниз при открытии диалога и приходе нового последнего
  // сообщения. Ключуемся на id последнего сообщения — подгрузка старой истории
  // (меняет первый, не последний) прокрутку не дёргает.
  const lastId = thread.length ? thread[thread.length - 1].id : null
  useEffect(() => {
    const el = messagesScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeId, lastId])

  return (
    <>
      {/* Шапка треда */}
      <header className="flex items-center gap-3 border-b border-border bg-card px-3 py-2.5 sm:px-4">
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
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {active.contactName}
            </span>
            {active.contactUsername ? (
              <span className="truncate text-xs text-muted-foreground">
                @{active.contactUsername}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{channelShort}</span>
            {active.channelName ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{active.channelName}</span>
              </>
            ) : null}
          </div>
        </div>
        <Button
          variant={infoOpen ? 'secondary' : 'ghost'}
          size="icon"
          onClick={onToggleInfo}
          aria-label="Сведения о диалоге"
          aria-pressed={infoOpen}
        >
          <Info className="size-4" />
        </Button>
      </header>

      {/* Лента — богатый MessageList менеджера в режиме read-only-действий */}
      {threadLoading && thread.length === 0 ? (
        <div className="flex flex-1 items-center justify-center bg-muted/20 text-sm text-muted-foreground">
          Загрузка переписки…
        </div>
      ) : thread.length === 0 ? (
        <div className="flex flex-1 items-center justify-center bg-muted/20 text-sm text-muted-foreground">
          Сообщений пока нет.
        </div>
      ) : (
        <MessageList
          active={active}
          activeId={activeId}
          thread={thread}
          threadLoading={threadLoading}
          noOlder={noOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlder}
          forwardTargets={[]}
          activeTyping={null}
          messagesScrollRef={messagesScrollRef}
          onThreadScroll={() => {}}
          onReply={onReply}
          onEdit={() => {}}
          onReact={() => {}}
          onCopy={onCopy}
          onForward={() => {}}
          onDelete={() => {}}
          onShowHistory={() => {}}
          readOnlyActions
        />
      )}

      {/* Черновик ответа-цитаты */}
      {replyTarget ? (
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-2 sm:px-4">
          <Reply className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2">
            <p className="truncate text-xs font-semibold text-foreground">
              {replyTarget.author || 'Сообщение'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {replyTarget.body ||
                (replyTarget.mediaType ? '[вложение]' : '')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={onCancelReply}
            aria-label="Отменить ответ"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}

      {/* Композер */}
      <CuratorComposer
        canAttach={canAttach}
        pending={pending}
        onSend={onSend}
        onSendMediaFile={onSendMediaFile}
      />
    </>
  )
}

function CuratorInfoPanel({
  active,
  onClose,
}: {
  active: Conversation
  onClose: () => void
}) {
  const channelShort =
    CHANNEL_VISUAL[active.channelType as PanelChannelType]?.short ??
    active.channelType
  const rows: { icon: typeof Radio; label: string; value: string }[] = []
  rows.push({ icon: Radio, label: 'Канал', value: channelShort })
  if (active.channelName)
    rows.push({ icon: Radio, label: 'Источник', value: active.channelName })
  if (active.transferredToCuratorAt)
    rows.push({
      icon: CalendarClock,
      label: 'Передан вам',
      value: listStamp(active.transferredToCuratorAt),
    })

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-border bg-card shadow-xl md:static md:z-auto md:w-80 md:shadow-none lg:w-[22rem]">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Сведения</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Закрыть сведения"
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-2 pb-4 text-center">
          <ContactAvatar
            name={active.contactName}
            channel={active.channelType}
            channelId={active.channelId}
            size="lg"
          />
          <div>
            <p className="text-sm font-semibold">{active.contactName}</p>
            {active.contactUsername ? (
              <p className="text-xs text-muted-foreground">
                @{active.contactUsername}
              </p>
            ) : null}
          </div>
          <Badge variant="secondary" className="shrink-0">
            {LEAD_STATUS_META[active.status].label}
          </Badge>
        </div>

        <dl className="flex flex-col gap-3 border-t border-border pt-4">
          {rows.map((r, i) => (
            <div key={i} className="flex items-start gap-2.5 text-xs">
              <r.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="font-medium text-foreground">{r.value}</dd>
              </div>
            </div>
          ))}
        </dl>

        {/* Контекст посетителя (лайв-чат сайта) */}
        {active.meta ? (
          <div className="mt-4 border-t border-border pt-4">
            <p className="mb-3 text-xs font-semibold text-muted-foreground">
              Посетитель сайта
            </p>
            <MetaRows meta={active.meta} />
          </div>
        ) : null}
      </div>
    </aside>
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  function submit() {
    const body = text.trim()
    if (!body) return
    onSend(body)
    setText('')
  }

  function insertEmoji(emoji: string) {
    const el = textareaRef.current
    if (!el) {
      setText((t) => t + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    // Вернуть каретку после вставленного эмодзи на следующем кадре.
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + emoji.length
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <form
      className="flex items-end gap-1.5 border-t border-border bg-card p-3"
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
      <EmojiPicker onPick={insertEmoji} />
      <textarea
        ref={textareaRef}
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
