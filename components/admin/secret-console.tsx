'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CheckCheck,
  Globe,
  Loader2,
  Mail,
  MailOpen,
  MessageSquare,
  MessagesSquare,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Radio,
  Search,
  Send,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react'
import {
  secretCreateConversationAction,
  secretDeleteConversationAction,
  secretDeleteMessageAction,
  secretFetchThreadAction,
  secretListConversationsAction,
  secretSendAsClientAction,
  secretSetConversationStatusAction,
  secretSetUnreadAction,
  secretUpdateConversationAction,
  type ConversationWithManager,
} from '@/app/actions/admin-secret'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { Channel, Manager, Message } from '@/lib/types'

/* ------------------------------- Labels ------------------------------- */

const TYPE_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

const TYPE_ICON: Record<string, typeof Send> = {
  telegram: Send,
  whatsapp: Phone,
  vk: Users,
  max: MessageSquare,
  livechat: Globe,
}

const CONV_STATUS_LABEL: Record<string, string> = {
  liquid: 'Ликвид',
  not_liquid: 'Не ликвид',
  unsubscribed: 'Отписка',
  transferred: 'Передан',
}

const CONV_STATUS_STYLE: Record<string, string> = {
  liquid: 'bg-success/15 text-success',
  not_liquid: 'bg-warning/15 text-warning',
  unsubscribed: 'bg-muted text-muted-foreground',
  transferred: 'bg-chart-2/15 text-foreground',
}

const STATUS_VALUES = ['liquid', 'not_liquid', 'unsubscribed', 'transferred']

/* ------------------------------ Helpers ------------------------------- */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function fmtDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isComposing(e: React.KeyboardEvent): boolean {
  // Don't submit while a CJK IME is composing (Safari reports keyCode 229).
  return e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229
}

/* ============================ Root component =========================== */

export function SecretConsole({
  channels,
  managers,
}: {
  channels: Channel[]
  managers: Manager[]
}) {
  const [conversations, setConversations] = useState<ConversationWithManager[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [conversation, setConversation] = useState<ConversationWithManager | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingThread, setLoadingThread] = useState(false)

  const [live, setLive] = useState(false)
  const [pending, startTransition] = useTransition()

  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)

  const listRefetch = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mirror the selected id into a ref during render so the long-lived SSE
  // handler (subscribed once) always reads the latest value without needing
  // to re-subscribe. Assigning in render is safe and lint-clean.
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId

  /* ----- list loading (server-side search + filter) ----- */
  const loadList = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoadingList(true)
      try {
        const rows = await secretListConversationsAction({
          search,
          channelType: typeFilter,
        })
        setConversations(rows)
      } catch {
        toast.error('Не удалось загрузить диалоги')
      } finally {
        setLoadingList(false)
      }
    },
    [search, typeFilter],
  )

  // Debounce filter/search-driven reloads.
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

  // Load (or clear) the open thread whenever the selection changes. This is a
  // legitimate "sync with an external system on selection change" effect.
  useEffect(() => {
    if (selectedId) void loadThread(selectedId)
    else {
      setConversation(null)
      setMessages([])
    }
  }, [selectedId, loadThread])

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

      // Append a live message to the open thread (dedupe by id).
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

      // Keep the rail fresh (new/updated conversations, unread counts, order).
      if (data.type === 'message' || data.type === 'conversation') {
        if (listRefetch.current) clearTimeout(listRefetch.current)
        listRefetch.current = setTimeout(() => void loadList({ silent: true }), 400)
      }
    })

    return () => {
      es.close()
      if (listRefetch.current) clearTimeout(listRefetch.current)
    }
    // Subscribe once for the component's lifetime; handlers read live refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ----- auto-scroll thread ----- */
  const endRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  /* ----- actions ----- */
  const managerName = useMemo(() => {
    const map = new Map(managers.map((m) => [m.id, m.name]))
    return (id: string | null) => (id ? map.get(id) ?? '—' : '—')
  }, [managers])

  function sendAsClient(body: string, onDone: () => void) {
    if (!selectedId) return
    const text = body.trim()
    if (!text) return
    startTransition(async () => {
      const res = await secretSendAsClientAction({ conversationId: selectedId, body: text })
      if (res.ok && res.createdMessage) {
        const created = res.createdMessage
        setMessages((prev) =>
          prev.some((m) => m.id === created.id) ? prev : [...prev, created],
        )
        onDone()
        void loadList({ silent: true })
      } else {
        toast.error(res.message)
      }
    })
  }

  function act(fn: () => Promise<{ ok: boolean; message: string }>, onOk?: () => void) {
    startTransition(async () => {
      try {
        const res = await fn()
        if (res.ok) {
          toast.success(res.message)
          onOk?.()
          void loadList({ silent: true })
          if (selectedIdRef.current) void loadThread(selectedIdRef.current)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  const showThreadPane = selectedId !== null

  return (
    <div className="flex h-[calc(100vh-19rem)] min-h-[30rem] overflow-hidden rounded-xl border border-border bg-card">
      {/* ---------------------- Conversation rail ---------------------- */}
      <aside
        className={cn(
          'flex w-full shrink-0 flex-col border-r border-border md:w-80 lg:w-96',
          showThreadPane ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Диалоги</h3>
            <Badge variant="secondary" className="tabular-nums">
              {conversations.length}
            </Badge>
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs',
                live ? 'text-success' : 'text-muted-foreground',
              )}
              title={live ? 'Живые обновления активны' : 'Переподключение…'}
            >
              <Radio className={cn('size-3.5', live && 'animate-pulse')} />
            </span>
          </div>
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> Новый
          </Button>
        </div>

        <div className="flex flex-col gap-2 border-b border-border p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по контакту или тексту"
              className="pl-8"
            />
          </div>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? 'all')}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все каналы</SelectItem>
              {Object.entries(TYPE_LABEL).map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingList ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={MessagesSquare}
                title="Диалоги не найдены"
                description="Измените фильтры или создайте новый диалог."
              />
            </div>
          ) : (
            <ul>
              {conversations.map((c) => {
                const Icon = TYPE_ICON[c.channelType] ?? MessageSquare
                const active = c.id === selectedId
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        'flex w-full items-start gap-3 border-b border-border/60 p-3 text-left transition-colors hover:bg-muted/50',
                        active && 'bg-muted',
                      )}
                    >
                      <div className="relative">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                          {initials(c.contactName)}
                        </div>
                        <span className="absolute -bottom-1 -right-1 flex size-4.5 items-center justify-center rounded-full border-2 border-card bg-muted">
                          <Icon className="size-2.5 text-muted-foreground" />
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {c.contactName}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {fmtTime(c.lastMessageAt)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-xs text-muted-foreground">
                            {c.lastMessage || '—'}
                          </p>
                          {c.unread > 0 && (
                            <span className="ml-auto flex size-4.5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground tabular-nums">
                              {c.unread > 9 ? '9+' : c.unread}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-medium',
                              CONV_STATUS_STYLE[c.status] ?? 'bg-muted text-muted-foreground',
                            )}
                          >
                            {CONV_STATUS_LABEL[c.status] ?? c.status}
                          </span>
                          <span className="truncate text-[10px] text-muted-foreground">
                            {c.managerName ?? '—'}
                          </span>
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

      {/* ------------------------- Thread pane ------------------------- */}
      <section
        className={cn(
          'min-w-0 flex-1 flex-col',
          showThreadPane ? 'flex' : 'hidden md:flex',
        )}
      >
        {!conversation ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              icon={MessageSquare}
              title="Выберите диалог"
              description="Слева выберите переписку, чтобы писать от имени клиента и видеть ответы менеджера вживую."
            />
          </div>
        ) : (
          <>
            <ThreadHeader
              conversation={conversation}
              managerName={managerName(conversation.managerId)}
              pending={pending}
              onBack={() => setSelectedId(null)}
              onStatus={(status) =>
                act(() => secretSetConversationStatusAction(conversation.id, status))
              }
              onToggleRead={() =>
                act(() => secretSetUnreadAction(conversation.id, conversation.unread > 0))
              }
              onEdit={() => setEditOpen(true)}
              onDelete={() =>
                act(() => secretDeleteConversationAction(conversation.id), () =>
                  setSelectedId(null),
                )
              }
            />

            <div className="flex-1 space-y-3 overflow-y-auto bg-muted/20 p-4">
              {loadingThread ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : messages.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  Сообщений пока нет. Напишите первое от имени клиента.
                </p>
              ) : (
                messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    pending={pending}
                    onDelete={() =>
                      act(() =>
                        secretDeleteMessageAction({
                          messageId: m.id,
                          conversationId: conversation.id,
                        }),
                      )
                    }
                  />
                ))
              )}
              <div ref={endRef} />
            </div>

            <Composer
              contactName={conversation.contactName}
              pending={pending}
              onSend={sendAsClient}
            />
          </>
        )}
      </section>

      <CreateConversationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        channels={channels}
        pending={pending}
        onCreated={(id) => {
          setCreateOpen(false)
          void loadList({ silent: true })
          if (id) setSelectedId(id)
        }}
      />

      {conversation && (
          <EditConversationDialog
            key={conversation.id}
            open={editOpen}
            onOpenChange={setEditOpen}
            conversation={conversation}
          managers={managers}
          pending={pending}
          onSaved={() => {
            setEditOpen(false)
            void loadList({ silent: true })
            if (selectedId) void loadThread(selectedId)
          }}
        />
      )}
    </div>
  )
}

/* ---------------------------- Thread header --------------------------- */

function ThreadHeader({
  conversation,
  managerName,
  pending,
  onBack,
  onStatus,
  onToggleRead,
  onEdit,
  onDelete,
}: {
  conversation: ConversationWithManager
  managerName: string
  pending: boolean
  onBack: () => void
  onStatus: (status: string) => void
  onToggleRead: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const Icon = TYPE_ICON[conversation.channelType] ?? MessageSquare
  return (
    <div className="flex flex-col gap-2 border-b border-border p-3">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 md:hidden"
          onClick={onBack}
          aria-label="Назад к списку"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {initials(conversation.contactName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{conversation.contactName}</span>
            <Badge variant="secondary" className="gap-1">
              <Icon className="size-3" />
              {TYPE_LABEL[conversation.channelType] ?? conversation.channelType}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {conversation.contactHandle} · Менеджер: {managerName}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={conversation.status} onValueChange={(v) => v && onStatus(v)}>
          <SelectTrigger className="h-8 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_VALUES.map((v) => (
              <SelectItem key={v} value={v}>
                {CONV_STATUS_LABEL[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          disabled={pending}
          onClick={onToggleRead}
        >
          {conversation.unread > 0 ? (
            <>
              <MailOpen className="size-3.5" /> Прочитано
            </>
          ) : (
            <>
              <Mail className="size-3.5" /> Непрочитано
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          disabled={pending}
          onClick={onEdit}
        >
          <Pencil className="size-3.5" /> Изменить
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-destructive"
          disabled={pending}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" /> Удалить
        </Button>
      </div>
    </div>
  )
}

/* ---------------------------- Message bubble -------------------------- */

function MessageBubble({
  message,
  pending,
  onDelete,
}: {
  message: Message
  pending: boolean
  onDelete: () => void
}) {
  // Admin impersonates the CLIENT: inbound ('in') = "us" → right side.
  const mine = message.direction === 'in'
  const deleted = Boolean(message.deletedAt)
  return (
    <div className={cn('group flex items-end gap-2', mine ? 'justify-end' : 'justify-start')}>
      {mine && !deleted && (
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          aria-label="Удалить сообщение"
          className="mb-1 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-sm',
          mine
            ? 'rounded-br-sm bg-primary text-primary-foreground'
            : 'rounded-bl-sm bg-card text-card-foreground border border-border',
        )}
      >
        <div className="mb-0.5 flex items-center gap-2">
          <span className={cn('flex items-center gap-1 text-[11px] font-medium', mine ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
            <UserRound className="size-3" />
            {message.author || (mine ? 'Клиент' : 'Менеджер')}
          </span>
          <span className={cn('text-[10px]', mine ? 'text-primary-foreground/60' : 'text-muted-foreground')}>
            {fmtDay(message.createdAt)}
          </span>
        </div>
        {deleted ? (
          <p className="italic opacity-70">Сообщение удалено</p>
        ) : (
          <>
            {message.mediaType && (
              <span
                className={cn(
                  'mb-1 inline-flex items-center gap-1 text-xs',
                  mine ? 'text-primary-foreground/80' : 'text-muted-foreground',
                )}
              >
                <Paperclip className="size-3" />
                {message.mediaName ?? 'Вложение'}
              </span>
            )}
            <p className="whitespace-pre-wrap break-words leading-relaxed">{message.body}</p>
          </>
        )}
      </div>
      {!mine && (
        <button
          type="button"
          onClick={onDelete}
          disabled={pending || deleted}
          aria-label="Удалить сообщение"
          className="mb-1 opacity-0 transition-opacity group-hover:opacity-100 disabled:hidden"
        >
          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </div>
  )
}

/* ------------------------------- Composer ----------------------------- */

function Composer({
  contactName,
  pending,
  onSend,
}: {
  contactName: string
  pending: boolean
  onSend: (body: string, onDone: () => void) => void
}) {
  const [body, setBody] = useState('')

  function submit() {
    if (!body.trim() || pending) return
    onSend(body, () => setBody(''))
  }

  return (
    <div className="border-t border-border p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Radio className="size-3.5 text-primary" />
        Вы пишете от имени клиента{' '}
        <span className="font-medium text-foreground">{contactName}</span>
      </div>
      <div className="flex items-end gap-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Сообщение от клиента… (Enter — отправить, Shift+Enter — перенос)"
          className="max-h-40 min-h-11 flex-1 resize-none"
          rows={1}
        />
        <Button onClick={submit} disabled={pending || !body.trim()} className="h-11 gap-1.5">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Отправить
        </Button>
      </div>
    </div>
  )
}

/* --------------------------- Create dialog ---------------------------- */

function CreateConversationDialog({
  open,
  onOpenChange,
  channels,
  pending,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  channels: Channel[]
  pending: boolean
  onCreated: (id: string | null) => void
}) {
  const [form, setForm] = useState({
    channelId: '',
    contactName: '',
    contactHandle: '',
    message: '',
  })
  const [, startTransition] = useTransition()

  function submit() {
    startTransition(async () => {
      const res = await secretCreateConversationAction(form)
      if (res.ok) {
        toast.success(res.message)
        setForm({ channelId: '', contactName: '', contactHandle: '', message: '' })
        onCreated(null)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый диалог</DialogTitle>
          <DialogDescription>
            Создайте переписку от имени клиента. Диалог привяжется к каналу и его
            менеджеру-владельцу и появится в его входящих.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Канал</Label>
            <Select
              value={form.channelId}
              onValueChange={(v) => setForm({ ...form, channelId: v ?? '' })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Выберите канал" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((ch) => (
                  <SelectItem key={ch.id} value={ch.id}>
                    {ch.name} · {TYPE_LABEL[ch.type] ?? ch.type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Имя клиента</Label>
              <Input
                value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                placeholder="Иван Петров"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Хэндл</Label>
              <Input
                value={form.contactHandle}
                onChange={(e) => setForm({ ...form, contactHandle: e.target.value })}
                placeholder="@user / +7…"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Первое сообщение от клиента</Label>
            <Textarea
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              placeholder="Необязательно"
              className="resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button disabled={pending} onClick={submit} className="gap-1.5">
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------------------- Edit dialog ----------------------------- */

function EditConversationDialog({
  open,
  onOpenChange,
  conversation,
  managers,
  pending,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  conversation: ConversationWithManager
  managers: Manager[]
  pending: boolean
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    contactName: conversation.contactName,
    contactHandle: conversation.contactHandle,
    managerId: conversation.managerId,
  })
  const [, startTransition] = useTransition()

  function submit() {
    startTransition(async () => {
      const res = await secretUpdateConversationAction({
        id: conversation.id,
        contactName: form.contactName,
        contactHandle: form.contactHandle,
        managerId: form.managerId,
      })
      if (res.ok) {
        toast.success(res.message)
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Изменить диалог</DialogTitle>
          <DialogDescription>
            Отре��актируйте данные клиента или переназначьте диалог другому менеджеру.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Имя клиента</Label>
            <Input
              value={form.contactName}
              onChange={(e) => setForm({ ...form, contactName: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Хэндл</Label>
            <Input
              value={form.contactHandle}
              onChange={(e) => setForm({ ...form, contactHandle: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Менеджер</Label>
            <Select
              value={form.managerId}
              onValueChange={(v) => setForm({ ...form, managerId: v ?? form.managerId })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Менеджер" />
              </SelectTrigger>
              <SelectContent>
                {managers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button disabled={pending} onClick={submit} className="gap-1.5">
            {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
