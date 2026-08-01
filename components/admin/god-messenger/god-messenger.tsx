'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  ChevronLeft,
  CornerUpLeft,
  Loader2,
  Plus,
  Radio,
  Search,
  Send,
  X,
  MessagesSquare,
} from 'lucide-react'
import {
  secretFetchThreadAction,
  secretListConversationsAction,
  secretSendMessageAction,
  type ConversationWithManager,
} from '@/app/actions/admin-secret'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Channel, Manager, Message } from '@/lib/types'
import { TYPE_LABEL, fmtTime, initials, isComposing } from './utils'
import { NewChatDialog } from './new-chat-dialog'
import { NotifyButton } from './notify-button'
import { MessageBubble } from './message-bubble'
import { buildReplyBody, parseReply, snippetOf } from './reply'

/**
 * God messenger root. A phone-first, full-screen chat surface where the god
 * "is" the client: MY messages (direction 'in') sit on the right, the manager's
 * replies (direction 'out') on the left — the mirror image of the manager inbox.
 * Reuses the god-console server actions + the admin SSE stream, so everything is
 * live and lands in the real manager inbox.
 */
export function GodMessenger({
  channels,
  managers,
  pushAvailable,
}: {
  channels: Channel[]
  managers: Manager[]
  pushAvailable: boolean
}) {
  const searchParams = useSearchParams()
  const deepLinkId = searchParams.get('c')

  const [conversations, setConversations] = useState<ConversationWithManager[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [search, setSearch] = useState('')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [conversation, setConversation] = useState<ConversationWithManager | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  // Render window: only the newest N messages hit the DOM. Long chats
  // (hundreds of messages) otherwise make opening a thread visibly slow on
  // mobile. "Показать ещё" expands the window; SSE appends work unchanged.
  const [visibleCount, setVisibleCount] = useState(MESSAGES_WINDOW)
  const [loadingThread, setLoadingThread] = useState(false)

  const [live, setLive] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [pending, startTransition] = useTransition()

  // Swipe-back: drag RIGHT anywhere in the thread (mobile, touch only) to
  // return to the chat list — like Telegram/iOS. Doesn't clash with
  // swipe-to-reply on bubbles because that gesture only claims LEFTWARD drags.
  const [backDrag, setBackDrag] = useState(0)
  const backStart = useRef<{ x: number; y: number } | null>(null)
  const backAxis = useRef<null | 'h' | 'v'>(null)

  const selectedIdRef = useRef<string | null>(null)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  const listRefetch = useRef<ReturnType<typeof setTimeout> | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const deepLinkApplied = useRef(false)

  const managerNameOf = useMemo(() => {
    const map = new Map(managers.map((m) => [m.id, m.name]))
    return (id: string | null) => (id ? map.get(id) ?? '—' : '—')
  }, [managers])

  /* ----- list loading ----- */
  const loadList = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoadingList(true)
      try {
        const rows = await secretListConversationsAction({
          search,
          channelType: 'all',
        })
        setConversations(rows)
      } catch {
        toast.error('Не удалось загрузить диалоги')
      } finally {
        setLoadingList(false)
      }
    },
    [search],
  )

  useEffect(() => {
    const id = setTimeout(() => void loadList(), 300)
    return () => clearTimeout(id)
  }, [loadList])

  /* ----- thread loading ----- */
  const loadThread = useCallback(async (id: string) => {
    setLoadingThread(true)
    try {
      const res = await secretFetchThreadAction(id)
      if (res.ok) {
        setConversation(res.conversation)
        setMessages(res.messages)
      } else {
        toast.error(res.message ?? 'Диалог недоступен')
      }
    } catch {
      toast.error('Не удалось загрузить переписку')
    } finally {
      setLoadingThread(false)
    }
  }, [])

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setReplyTo(null)
    setVisibleCount(MESSAGES_WINDOW)
    if (selectedId) void loadThread(selectedId)
    else {
      setConversation(null)
      setMessages([])
    }
  }, [selectedId, loadThread])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Apply the ?c=<id> deep link (from a push notification) once.
  useEffect(() => {
    if (deepLinkApplied.current || !deepLinkId) return
    deepLinkApplied.current = true
    setSelectedId(deepLinkId)
  }, [deepLinkId])

  /* ----- live updates via admin SSE ----- */
  useEffect(() => {
    const es = new EventSource('/api/wijegniwjgwjog/stream')
    es.addEventListener('ready', () => setLive(true))
    es.onerror = () => setLive(false)

    es.addEventListener('update', (ev) => {
      let data: {
        type?: string
        event?: string
        conversationId?: string
        id?: string
        direction?: 'in' | 'out'
        body?: string
        author?: string
        createdAt?: string
      }
      try {
        data = JSON.parse((ev as MessageEvent).data)
      } catch {
        return
      }

      if (
        data.type === 'message' &&
        data.event !== 'update' &&
        data.conversationId &&
        data.conversationId === selectedIdRef.current &&
        data.id
      ) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === data.id)) return prev
          return [
            ...prev,
            {
              id: data.id as string,
              conversationId: data.conversationId as string,
              direction: (data.direction ?? 'out') as 'in' | 'out',
              body: data.body ?? '',
              author: data.author ?? '',
              createdAt: data.createdAt ?? new Date().toISOString(),
            },
          ]
        })
      }

      if (data.type === 'message' || data.type === 'conversation') {
        if (listRefetch.current) clearTimeout(listRefetch.current)
        listRefetch.current = setTimeout(() => void loadList({ silent: true }), 400)
      }
    })

    return () => {
      es.close()
      if (listRefetch.current) clearTimeout(listRefetch.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ----- auto-scroll ----- */
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  /* ----- reply handling ----- */
  const startReply = useCallback((message: Message) => {
    setReplyTo(message)
    composerRef.current?.focus()
  }, [])

  /* ----- swipe right anywhere in the thread → back to list ----- */
  const onBackPointerDown = useCallback((e: React.PointerEvent) => {
    // Touch only: a mouse drag on desktop must never slide the panel. Also
    // skip on md+ layouts where the list is already visible beside the thread.
    if (e.pointerType !== 'touch') return
    if (window.matchMedia('(min-width: 768px)').matches) return
    backStart.current = { x: e.clientX, y: e.clientY }
    backAxis.current = null
  }, [])

  const onBackPointerMove = useCallback((e: React.PointerEvent) => {
    if (!backStart.current) return
    const dx = e.clientX - backStart.current.x
    const dy = Math.abs(e.clientY - backStart.current.y)
    // Lock the axis once, exactly like the bubble gesture: a mostly-vertical
    // move is a scroll (give up), a mostly-horizontal RIGHTWARD move is ours.
    if (backAxis.current === null) {
      if (dx > 8 && dx > dy) backAxis.current = 'h'
      else if (dy > 8 || dx < -8) backAxis.current = 'v'
    }
    if (backAxis.current === 'h') {
      setBackDrag(Math.min(Math.max(dx, 0), THREAD_DRAG_MAX))
    }
  }, [])

  const onBackPointerEnd = useCallback(() => {
    if (!backStart.current) return
    backStart.current = null
    backAxis.current = null
    setBackDrag((d) => {
      if (d >= THREAD_DRAG_TRIGGER) setSelectedId(null)
      return 0
    })
  }, [])

  /* ----- send as client ----- */
  const sendMessage = useCallback(() => {
    const text = draft.trim()
    if (!text || !selectedIdRef.current) return
    const target = replyTo
    const body = target ? buildReplyBody(target, text) : text
    setDraft('')
    setReplyTo(null)
    startTransition(async () => {
      const res = await secretSendMessageAction({
        conversationId: selectedIdRef.current as string,
        body,
        direction: 'in',
      })
      if (res.ok) {
        void loadThread(selectedIdRef.current as string)
        void loadList({ silent: true })
      } else {
        toast.error(res.message)
        setDraft(text)
        setReplyTo(target)
      }
    })
  }, [draft, replyTo, loadThread, loadList])

  const showThread = selectedId !== null

  const replyLabel = replyTo
    ? replyTo.direction === 'in'
      ? 'Вы'
      : managerNameOf(conversation?.managerId ?? null)
    : ''

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        {/* ------------------------- Chat list ------------------------- */}
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
                  onClick={() => setCreateOpen(true)}
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
                onChange={(e) => setSearch(e.target.value)}
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
                <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" /> Новый диалог
                </Button>
              </div>
            ) : (
              <ul className="space-y-0.5 p-2">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
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
                          c.unread > 0 && 'ring-2 ring-primary/40 ring-offset-2 ring-offset-background',
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
                              c.unread > 0 ? 'font-semibold' : 'font-medium',
                            )}
                          >
                            {c.contactName || c.contactHandle}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {c.lastMessageAt ? fmtTime(c.lastMessageAt) : ''}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'truncate text-xs',
                              c.unread > 0
                                ? 'font-medium text-foreground'
                                : 'text-muted-foreground',
                            )}
                          >
                            {parseReply(c.lastMessage || '').text || 'Нет сообщений'}
                          </span>
                          {c.unread > 0 && (
                            <Badge className="h-5 min-w-5 shrink-0 justify-center rounded-full px-1.5 text-[11px] tabular-nums">
                              {c.unread}
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

        {/* -------------------------- Thread --------------------------- */}
        <section
          className={cn(
            'relative min-w-0 flex-1 flex-col',
            showThread ? 'flex' : 'hidden md:flex',
          )}
          style={{
            transform: backDrag ? `translateX(${backDrag}px)` : undefined,
            transition: backDrag ? 'none' : 'transform 0.2s ease-out',
            // Promote to its own compositor layer only WHILE dragging, so the
            // swipe-back tracks the finger without jank on weak GPUs.
            willChange: backDrag ? 'transform' : undefined,
            touchAction: 'pan-y',
          }}
          onPointerDown={conversation ? onBackPointerDown : undefined}
          onPointerMove={conversation ? onBackPointerMove : undefined}
          onPointerUp={conversation ? onBackPointerEnd : undefined}
          onPointerCancel={conversation ? onBackPointerEnd : undefined}
        >
          {!conversation ? (
            <div className="hidden flex-1 items-center justify-center p-6 md:flex">
              <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
                <MessagesSquare className="size-12 opacity-40" />
                <p className="text-sm">Выберите диалог слева</p>
              </div>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-2 border-b border-border bg-card/40 px-2 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] backdrop-blur sm:px-3">
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                  aria-label="Назад к списку"
                >
                  <ChevronLeft className="size-6" />
                </button>
                <Avatar className="size-10 shrink-0">
                  <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                    {initials(conversation.contactName || conversation.contactHandle)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold leading-tight">
                    {conversation.contactName || conversation.contactHandle}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {TYPE_LABEL[conversation.channelType] ?? conversation.channelType} ·
                    Менеджер: {managerNameOf(conversation.managerId)}
                  </p>
                </div>
              </header>

              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain bg-muted/20 px-2 py-4 sm:px-3">
                {loadingThread ? (
                  <div className="flex items-center justify-center py-16 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    Сообщений пока нет. Напишите первое.
                  </p>
                ) : (
                  <>
                    {messages.length > visibleCount && (
                      <button
                        type="button"
                        onClick={() =>
                          setVisibleCount((c) => c + MESSAGES_WINDOW)
                        }
                        className="mx-auto mb-2 block rounded-full border border-border bg-background px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        Показать ещё ({messages.length - visibleCount} скрыто)
                      </button>
                    )}
                    {messages.slice(-visibleCount).map((m, i, visible) => (
                      <MessageBubble
                        key={m.id}
                        message={m}
                        prev={visible[i - 1]}
                        onReply={startReply}
                      />
                    ))}
                  </>
                )}
                <div ref={endRef} />
              </div>

              {/* --------------------- Composer --------------------- */}
              <div className="border-t border-border bg-background px-2 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2 sm:px-3">
                {replyTo && (
                  <div className="mb-2 flex items-center gap-2 rounded-xl border-l-2 border-primary bg-muted/60 py-2 pl-3 pr-2">
                    <CornerUpLeft className="size-4 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-primary">{replyLabel}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {snippetOf(replyTo) || 'Сообщение'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplyTo(null)}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label="Отменить ответ"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    ref={composerRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
                        e.preventDefault()
                        sendMessage()
                      }
                    }}
                    rows={1}
                    placeholder="Сообщение от имени клиента…"
                    className="max-h-40 min-h-[52px] flex-1 resize-none rounded-3xl border border-input bg-card px-4 py-3.5 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button
                    size="icon"
                    className="size-12 shrink-0 rounded-full"
                    onClick={sendMessage}
                    disabled={pending || !draft.trim()}
                    aria-label="Отправить"
                  >
                    {pending ? (
                      <Loader2 className="size-5 animate-spin" />
                    ) : (
                      <Send className="size-5" />
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <NewChatDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        channels={channels}
        onCreated={() => {
          setCreateOpen(false)
          void loadList({ silent: true })
        }}
      />
    </div>
  )
}

/* Swipe-right-back thresholds (thread → list, anywhere in the thread). */
const THREAD_DRAG_MAX = 120
const THREAD_DRAG_TRIGGER = 70

/* How many newest messages are rendered initially / added per "show more". */
const MESSAGES_WINDOW = 50

