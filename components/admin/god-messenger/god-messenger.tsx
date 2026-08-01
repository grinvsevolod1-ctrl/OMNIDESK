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
import { toast } from 'sonner'
import {
  Check,
  CheckCheck,
  ChevronLeft,
  Loader2,
  Plus,
  Radio,
  Search,
  Send,
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
import {
  TYPE_LABEL,
  fmtDay,
  fmtTime,
  initials,
  isComposing,
} from '@/components/admin/secret-console/utils'
import { NewChatDialog } from './new-chat-dialog'
import { NotifyButton } from './notify-button'

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
  const [loadingThread, setLoadingThread] = useState(false)

  const [live, setLive] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, startTransition] = useTransition()

  const selectedIdRef = useRef<string | null>(null)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  const listRefetch = useRef<ReturnType<typeof setTimeout> | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
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

  /* ----- send as client ----- */
  const sendMessage = useCallback(() => {
    const body = draft.trim()
    if (!body || !selectedIdRef.current) return
    setDraft('')
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
        setDraft(body)
      }
    })
  }, [draft, loadThread, loadList])

  const showThread = selectedId !== null

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
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
            <div className="flex items-center gap-2">
              <div
                className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <MessagesSquare className="size-5" />
              </div>
              <div>
                <h1 className="text-base font-semibold leading-none">Messages</h1>
                <span
                  className={cn(
                    'mt-1 inline-flex items-center gap-1 text-xs',
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
                className="size-9"
                onClick={() => setCreateOpen(true)}
                aria-label="Новый диалог"
              >
                <Plus className="size-5" />
              </Button>
            </div>
          </header>

          <div className="border-b border-border p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск диалога"
                className="pl-8"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
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
              <ul className="divide-y divide-border">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        'flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50',
                        c.id === selectedId && 'bg-muted',
                      )}
                    >
                      <Avatar className="size-11 shrink-0">
                        <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                          {initials(c.contactName || c.contactHandle)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {c.contactName || c.contactHandle}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {c.lastMessageAt ? fmtTime(c.lastMessageAt) : ''}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs text-muted-foreground">
                            {c.lastMessage || 'Нет сообщений'}
                          </span>
                          {c.unread > 0 && (
                            <Badge className="h-5 min-w-5 shrink-0 justify-center rounded-full px-1.5 text-[11px] tabular-nums">
                              {c.unread}
                            </Badge>
                          )}
                        </div>
                        <span className="mt-0.5 inline-block text-[10px] uppercase tracking-wide text-muted-foreground/70">
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
            'min-w-0 flex-1 flex-col',
            showThread ? 'flex' : 'hidden md:flex',
          )}
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
              <header className="flex items-center gap-3 border-b border-border px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                  aria-label="Назад к списку"
                >
                  <ChevronLeft className="size-5" />
                </button>
                <Avatar className="size-9 shrink-0">
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

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-muted/20 px-3 py-4">
                {loadingThread ? (
                  <div className="flex items-center justify-center py-16 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    Сообщений пока нет. Напишите первое.
                  </p>
                ) : (
                  messages.map((m, i) => (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      prev={messages[i - 1]}
                    />
                  ))
                )}
                <div ref={endRef} />
              </div>

              <div className="flex items-end gap-2 border-t border-border bg-background px-3 py-2.5">
                <textarea
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
                  className="max-h-32 min-h-10 flex-1 resize-none rounded-2xl border border-input bg-card px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button
                  size="icon"
                  className="size-10 shrink-0 rounded-full"
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

/* --------------------------- Message bubble ---------------------------- */

/**
 * One message. Perspective is inverted vs. the manager inbox: an INBOUND message
 * (direction 'in') is what the god typed AS THE CLIENT, so it sits on the RIGHT
 * as "mine"; an OUTBOUND message (direction 'out') is the manager's reply, shown
 * on the LEFT as "theirs".
 */
function MessageBubble({
  message,
  prev,
}: {
  message: Message
  prev?: Message
}) {
  const mine = message.direction === 'in'

  // Day separator when the calendar day changes.
  const showDay =
    !prev ||
    new Date(prev.createdAt).toDateString() !==
      new Date(message.createdAt).toDateString()

  return (
    <>
      {showDay && (
        <div className="flex justify-center py-2">
          <span className="rounded-full bg-muted px-3 py-0.5 text-[11px] text-muted-foreground">
            {fmtDay(message.createdAt).split(' ')[0]}
          </span>
        </div>
      )}
      <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
        <div
          className={cn(
            'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm',
            mine
              ? 'rounded-br-md bg-primary text-primary-foreground'
              : 'rounded-bl-md bg-card text-card-foreground',
          )}
        >
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {message.body}
          </p>
          <span
            className={cn(
              'mt-0.5 flex items-center justify-end gap-1 text-[10px]',
              mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
            )}
          >
            {fmtTime(message.createdAt)}
            {mine &&
              (message.status === 'read' ? (
                <CheckCheck className="size-3" />
              ) : (
                <Check className="size-3" />
              ))}
          </span>
        </div>
      </div>
    </>
  )
}
