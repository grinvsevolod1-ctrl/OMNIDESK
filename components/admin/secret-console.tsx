'use client'

import {
  memo,
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
  Ban,
  Bot,
  CheckCheck,
  Filter,
  Hand,
  Info,
  Loader2,
  Mail,
  MailOpen,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Radio,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { ChannelIcon } from '@/components/channel-icons'
import {
  secretCreateConversationAction,
  secretDeleteConversationAction,
  secretDeleteMessageAction,
  secretFetchThreadAction,
  secretListConversationsAction,
  secretSendAsClientAction,
  secretSetContactBlockedAction,
  secretSetConversationStatusAction,
  secretSetThreadSimAction,
  secretSetUnreadAction,
  secretUpdateConversationAction,
  type ConversationWithManager,
  type ConversationWithSim,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { Channel, Manager, Message } from '@/lib/types'

/** Simulator-involvement shape, derived from the god-console view model. */
type SimInfo = ConversationWithSim['sim']

/* ------------------------------- Labels ------------------------------- */

const TYPE_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

const CONV_STATUS_LABEL: Record<string, string> = {
  liquid: 'Ликвид',
  not_liquid: 'Не ликвид',
  unsubscribed: 'Отписка',
  handoff: 'Передан человеку',
  transferred: 'Передан',
}

const CONV_STATUS_STYLE: Record<string, string> = {
  liquid: 'bg-success/15 text-success',
  not_liquid: 'bg-warning/15 text-warning',
  unsubscribed: 'bg-muted text-muted-foreground',
  handoff: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  transferred: 'bg-chart-2/15 text-foreground',
}

const STATUS_VALUES = [
  'unsubscribed',
  'handoff',
  'liquid',
  'not_liquid',
  'transferred',
]

/** Human labels for the auto-client lifecycle (shown only inside "Детали"). */
const SIM_STATE_LABEL: Record<string, string> = {
  opening: 'открывает диалог',
  chatting: 'активная переписка',
  ignoring: 'притих',
  later: 'ответит позже',
  sleeping: 'спит',
  vanished: 'пропал',
  done: 'завершён',
}

/** List-level involvement filter. */
type SimFilter = 'all' | 'driving' | 'paused' | 'plain'
/** Thread-level direction filter. */
type DirFilter = 'all' | 'in' | 'out'

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

/** Split `text` on `query` (case-insensitive) and wrap matches in <mark>. */
function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim()
  if (!q) return text
  const parts: React.ReactNode[] = []
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  let i = 0
  let key = 0
  while (i < text.length) {
    const at = lower.indexOf(needle, i)
    if (at === -1) {
      parts.push(text.slice(i))
      break
    }
    if (at > i) parts.push(text.slice(i, at))
    parts.push(
      <mark
        key={key++}
        className="rounded-sm bg-warning/40 px-0.5 text-inherit"
      >
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    i = at + needle.length
  }
  return parts
}

/* ============================ Root component =========================== */

export function SecretConsole({
  channels,
  managers,
}: {
  channels: Channel[]
  managers: Manager[]
}) {
  const [conversations, setConversations] = useState<ConversationWithSim[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')

  // Client-side rail filters (applied on top of the server list; no refetch).
  const [simFilter, setSimFilter] = useState<SimFilter>('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [unreadOnly, setUnreadOnly] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [conversation, setConversation] = useState<ConversationWithManager | null>(null)
  const [threadSim, setThreadSim] = useState<SimInfo>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingThread, setLoadingThread] = useState(false)

  // Thread-level message filter (progressive: hidden until toggled).
  const [showThreadFilter, setShowThreadFilter] = useState(false)
  const [dirFilter, setDirFilter] = useState<DirFilter>('all')
  const [msgSearch, setMsgSearch] = useState('')

  const [live, setLive] = useState(false)
  const [pending, startTransition] = useTransition()

  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)

  const listRefetch = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mirror the selected id after commit so the long-lived SSE handler reads
  // the latest selection without mutating a ref during render.
  const selectedIdRef = useRef<string | null>(null)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  /* ----- list loading (server-side search + channel filter) ----- */
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
        setThreadSim(res.sim)
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
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (selectedId) void loadThread(selectedId)
    else {
      setConversation(null)
      setThreadSim(null)
      setMessages([])
    }
  }, [selectedId, loadThread])
  /* eslint-enable react-hooks/set-state-in-effect */

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

  /* ----- derived data ----- */
  const managerNameOf = useMemo(() => {
    const map = new Map(managers.map((m) => [m.id, m.name]))
    return (id: string | null) => (id ? map.get(id) ?? '—' : '—')
  }, [managers])

  // Whether any simulated conversation exists at all — drives whether we even
  // show the involvement filter (keeps the UI clean when nothing is simulated).
  const hasAnySim = useMemo(
    () => conversations.some((c) => c.sim != null),
    [conversations],
  )

  // Client-side filtered rail. Cheap, memoised, no refetch.
  const visibleConversations = useMemo(() => {
    return conversations.filter((c) => {
      if (unreadOnly && c.unread <= 0) return false
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (simFilter === 'driving' && !(c.sim?.active && !c.sim.paused)) return false
      if (simFilter === 'paused' && !(c.sim?.active && c.sim.paused)) return false
      if (simFilter === 'plain' && c.sim?.active) return false
      return true
    })
  }, [conversations, unreadOnly, statusFilter, simFilter])

  const activeFilterCount =
    (simFilter !== 'all' ? 1 : 0) +
    (statusFilter !== 'all' ? 1 : 0) +
    (unreadOnly ? 1 : 0)

  // Thread messages after the (progressive) direction + text filter.
  const visibleMessages = useMemo(() => {
    const q = msgSearch.trim().toLowerCase()
    return messages.filter((m) => {
      if (dirFilter !== 'all' && m.direction !== dirFilter) return false
      if (q && !(m.body ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [messages, dirFilter, msgSearch])

  /* ----- actions ----- */
  const handleSelect = useCallback((id: string) => setSelectedId(id), [])

  const sendAsClient = useCallback(
    (body: string, onDone: () => void) => {
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
          if (res.simDetached) {
            setThreadSim((s) => (s ? { ...s, paused: true } : s))
            toast.info('Вы вступили в диалог — симулятор отключён от него')
          }
          void loadList({ silent: true })
        } else {
          toast.error(res.message)
        }
      })
    },
    [selectedId, loadList],
  )

  const act = useCallback(
    (fn: () => Promise<{ ok: boolean; message: string }>, onOk?: () => void) => {
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
    },
    [loadList, loadThread],
  )

  // Detach / re-attach the simulator for the OPEN dialogue only.
  const setSim = useCallback(
    (enabled: boolean) => {
      if (!selectedId) return
      // Optimistic flip for instant feedback; the reload reconciles truth.
      setThreadSim((s) => (s ? { ...s, paused: !enabled } : s))
      act(() => secretSetThreadSimAction({ conversationId: selectedId, enabled }))
    },
    [selectedId, act],
  )

  const deleteMessage = useCallback(
    (messageId: string) => {
      if (!selectedIdRef.current) return
      act(() =>
        secretDeleteMessageAction({
          messageId,
          conversationId: selectedIdRef.current as string,
        }),
      )
    },
    [act],
  )

  const showThreadPane = selectedId !== null
  const simDriving = Boolean(threadSim?.active && !threadSim.paused)

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
              {visibleConversations.length}
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

        {/* Primary controls stay inline; advanced filters hide in a popover. */}
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по контакту или тексту"
              className="pl-8"
            />
          </div>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className="relative h-9 w-9 shrink-0"
                  aria-label="Фильтры"
                />
              }
            >
              <Filter className="size-4" />
              {activeFilterCount > 0 && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground tabular-nums">
                  {activeFilterCount}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Фильтры</span>
                {activeFilterCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setSimFilter('all')
                      setStatusFilter('all')
                      setUnreadOnly(false)
                    }}
                  >
                    Сбросить
                  </Button>
                )}
              </div>

              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">Канал</Label>
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

              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">Статус</Label>
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? 'all')}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Любой статус</SelectItem>
                    {STATUS_VALUES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {CONV_STATUS_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {hasAnySim && (
                <div className="grid gap-1.5">
                  <Label className="text-xs text-muted-foreground">Ведение</Label>
                  <Select value={simFilter} onValueChange={(v) => setSimFilter((v as SimFilter) ?? 'all')}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все диалоги</SelectItem>
                      <SelectItem value="driving">Ведёт симулятор</SelectItem>
                      <SelectItem value="paused">На паузе (вы)</SelectItem>
                      <SelectItem value="plain">Обычные</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              <Separator />
              <label className="flex cursor-pointer items-center justify-between">
                <span className="text-sm">Только непрочитанные</span>
                <Switch checked={unreadOnly} onCheckedChange={setUnreadOnly} />
              </label>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingList ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : visibleConversations.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={MessagesSquare}
                title="Диалоги не найдены"
                description="Измените фильтры или создайте новый диалог."
              />
            </div>
          ) : (
            <ul>
              {visibleConversations.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  active={c.id === selectedId}
                  onSelect={handleSelect}
                />
              ))}
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
              sim={threadSim}
              managerName={managerNameOf(conversation.managerId)}
              pending={pending}
              filterActive={showThreadFilter || dirFilter !== 'all' || msgSearch.trim() !== ''}
              onToggleFilter={() => setShowThreadFilter((v) => !v)}
              onBack={() => setSelectedId(null)}
              onSetSim={setSim}
              onStatus={(status) =>
                act(() => secretSetConversationStatusAction(conversation.id, status))
              }
              onToggleRead={() =>
                act(() => secretSetUnreadAction(conversation.id, conversation.unread > 0))
              }
              onToggleBlock={() =>
                act(() =>
                  secretSetContactBlockedAction(
                    conversation.id,
                    !conversation.contactBlocked,
                  ),
                )
              }
              onEdit={() => setEditOpen(true)}
              onDelete={() =>
                act(() => secretDeleteConversationAction(conversation.id), () =>
                  setSelectedId(null),
                )
              }
            />

            {showThreadFilter && (
              <ThreadFilterBar
                dirFilter={dirFilter}
                onDir={setDirFilter}
                search={msgSearch}
                onSearch={setMsgSearch}
                shown={visibleMessages.length}
                total={messages.length}
                onClose={() => {
                  setShowThreadFilter(false)
                  setDirFilter('all')
                  setMsgSearch('')
                }}
              />
            )}

            <div className="flex-1 space-y-3 overflow-y-auto bg-muted/20 p-4">
              {loadingThread ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : messages.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  Сообщений пока нет. Напишите первое от имени клиента.
                </p>
              ) : visibleMessages.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  Ничего не найдено по фильтру.
                </p>
              ) : (
                visibleMessages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    highlightQuery={msgSearch}
                    pending={pending}
                    onDelete={deleteMessage}
                  />
                ))
              )}
              <div ref={endRef} />
            </div>

            <Composer
              contactName={conversation.contactName}
              pending={pending}
              simDriving={simDriving}
              onIntervene={() => setSim(false)}
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

/* --------------------------- Conversation row ------------------------- */

const ConversationRow = memo(function ConversationRow({
  conversation: c,
  active,
  onSelect,
}: {
  conversation: ConversationWithSim
  active: boolean
  onSelect: (id: string) => void
}) {
  const simDriving = Boolean(c.sim?.active && !c.sim.paused)
  const simPaused = Boolean(c.sim?.active && c.sim.paused)
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        className={cn(
          'flex w-full items-start gap-3 border-b border-border/60 p-3 text-left transition-colors hover:bg-muted/50',
          active && 'bg-muted',
        )}
      >
        <div className="relative">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {initials(c.contactName)}
          </div>
          <span className="absolute -bottom-1 -right-1 flex size-4.5 items-center justify-center rounded-full border-2 border-card bg-card">
            <ChannelIcon type={c.channelType} className="size-3 rounded-full" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{c.contactName}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
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
            {c.contactBlocked && (
              <Ban className="size-3 shrink-0 text-destructive" aria-label="Менеджер заблокирован клиентом" />
            )}
            {simDriving && (
              <span
                className="flex items-center gap-1 rounded bg-chart-2/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground"
                title="Диалог ведёт симулятор"
              >
                <Bot className="size-3" /> Симулятор
              </span>
            )}
            {simPaused && (
              <span
                className="flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
                title="Вы управляете этим диалогом"
              >
                <Hand className="size-3" /> Вы
              </span>
            )}
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
})

/* ---------------------------- Thread header --------------------------- */

function ThreadHeader({
  conversation,
  sim,
  managerName,
  pending,
  filterActive,
  onToggleFilter,
  onBack,
  onSetSim,
  onStatus,
  onToggleRead,
  onToggleBlock,
  onEdit,
  onDelete,
}: {
  conversation: ConversationWithManager
  sim: SimInfo
  managerName: string
  pending: boolean
  filterActive: boolean
  onToggleFilter: () => void
  onBack: () => void
  onSetSim: (enabled: boolean) => void
  onStatus: (status: string) => void
  onToggleRead: () => void
  onToggleBlock: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const blocked = Boolean(conversation.contactBlocked)
  const simActive = Boolean(sim?.active)
  const simDriving = Boolean(sim?.active && !sim.paused)

  return (
    <div className="flex items-center gap-2 border-b border-border p-3">
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
          <Badge variant="secondary" className="hidden gap-1 sm:inline-flex">
            <ChannelIcon type={conversation.channelType} className="size-3 rounded-full" />
            {TYPE_LABEL[conversation.channelType] ?? conversation.channelType}
          </Badge>
          {blocked && (
            <Badge variant="destructive" className="gap-1">
              <Ban className="size-3" />
              <span className="hidden sm:inline">Заблокирован</span>
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {conversation.contactHandle} · {managerName}
        </p>
      </div>

      {/* Simulator take-over control — only for simulated dialogues. */}
      {simActive && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1.5',
            simDriving
              ? 'border-chart-2/40 bg-chart-2/10'
              : 'border-warning/40 bg-warning/10',
          )}
        >
          {simDriving ? (
            <Bot className="size-4 shrink-0 text-foreground" aria-hidden />
          ) : (
            <Hand className="size-4 shrink-0 text-warning" aria-hidden />
          )}
          <div className="hidden min-w-0 flex-col leading-tight sm:flex">
            <span className="text-xs font-medium">
              {simDriving ? 'Ведёт симулятор' : 'Вы управляете'}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {simDriving ? 'вмешайтесь, чтобы взять' : 'симулятор на паузе'}
            </span>
          </div>
          <Switch
            checked={simDriving}
            onCheckedChange={onSetSim}
            disabled={pending}
            aria-label="Передать диалог симулятору"
          />
        </div>
      )}

      {/* Message filter toggle (progressive disclosure). */}
      <Button
        variant={filterActive ? 'default' : 'outline'}
        size="icon"
        className="size-9 shrink-0"
        onClick={onToggleFilter}
        aria-label="Фильтр сообщений"
      >
        <Search className="size-4" />
      </Button>

      {/* Everything else tucked away to keep the header calm. */}
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="outline" size="icon" className="size-9 shrink-0" aria-label="Действия и детали" />
          }
        >
          <MoreHorizontal className="size-4" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-3">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Статус диалога</Label>
            <Select value={conversation.status} onValueChange={(v) => v && onStatus(v)}>
              <SelectTrigger className="h-9">
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
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending} onClick={onToggleRead}>
              {conversation.unread > 0 ? (
                <>
                  <MailOpen className="size-3.5" /> Прочитано
                </>
              ) : (
                <>
                  <Mail className="size-3.5" /> Непроч.
                </>
              )}
            </Button>
            <Button
              variant={blocked ? 'default' : 'outline'}
              size="sm"
              className="h-8 gap-1.5"
              disabled={pending}
              onClick={onToggleBlock}
            >
              {blocked ? (
                <>
                  <ShieldCheck className="size-3.5" /> Разбл.
                </>
              ) : (
                <>
                  <Ban className="size-3.5" /> Блок
                </>
              )}
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending} onClick={onEdit}>
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

          {simActive && sim && (
            <>
              <Separator />
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <Info className="size-3.5" /> Детали ведения
                </div>
                {sim.personaName && <p>Персона: {sim.personaName}</p>}
                <p>Стадия: {SIM_STATE_LABEL[sim.state] ?? sim.state}</p>
                <p>{sim.paused ? 'Симулятор отключён — вы ведёте диалог.' : 'Диалог автоматически ведёт симулятор.'}</p>
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/* -------------------------- Thread filter bar ------------------------- */

function ThreadFilterBar({
  dirFilter,
  onDir,
  search,
  onSearch,
  shown,
  total,
  onClose,
}: {
  dirFilter: DirFilter
  onDir: (d: DirFilter) => void
  search: string
  onSearch: (v: string) => void
  shown: number
  total: number
  onClose: () => void
}) {
  const segments: { value: DirFilter; label: string }[] = [
    { value: 'all', label: 'Все' },
    { value: 'in', label: 'Клиент' },
    { value: 'out', label: 'Менеджер' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 p-2.5">
      <div className="flex items-center rounded-md border border-border bg-card p-0.5">
        {segments.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => onDir(s.value)}
            className={cn(
              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
              dirFilter === s.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="relative min-w-40 flex-1">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Поиск по переписке"
          className="h-8 pl-8 text-sm"
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {shown}/{total}
      </span>
      <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="Скрыть фильтр">
        <X className="size-4" />
      </Button>
    </div>
  )
}

/* ---------------------------- Message bubble -------------------------- */

const MessageBubble = memo(function MessageBubble({
  message,
  highlightQuery,
  pending,
  onDelete,
}: {
  message: Message
  highlightQuery: string
  pending: boolean
  onDelete: (messageId: string) => void
}) {
  // Admin impersonates the CLIENT: inbound ('in') = "us" → right side.
  const mine = message.direction === 'in'
  const deleted = Boolean(message.deletedAt)
  return (
    <div className={cn('group flex items-end gap-2', mine ? 'justify-end' : 'justify-start')}>
      {mine && !deleted && (
        <button
          type="button"
          onClick={() => onDelete(message.id)}
          disabled={pending}
          aria-label="Удалит�� сообщение"
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
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {highlight(message.body, highlightQuery)}
            </p>
          </>
        )}
      </div>
      {!mine && (
        <button
          type="button"
          onClick={() => onDelete(message.id)}
          disabled={pending || deleted}
          aria-label="Удалить сообщение"
          className="mb-1 opacity-0 transition-opacity group-hover:opacity-100 disabled:hidden"
        >
          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </div>
  )
})

/* ------------------------------- Composer ----------------------------- */

function Composer({
  contactName,
  pending,
  simDriving,
  onIntervene,
  onSend,
}: {
  contactName: string
  pending: boolean
  simDriving: boolean
  onIntervene: () => void
  onSend: (body: string, onDone: () => void) => void
}) {
  const [body, setBody] = useState('')

  function submit() {
    if (!body.trim() || pending) return
    onSend(body, () => setBody(''))
  }

  return (
    <div className="border-t border-border p-3">
      {simDriving && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-chart-2/40 bg-chart-2/10 px-3 py-2 text-xs">
          <Bot className="size-4 shrink-0 text-foreground" />
          <span className="flex-1 text-muted-foreground">
            Диалог ведёт симулятор. Отправьте сообщение или нажмите «Вмешаться» — симулятор отключится от этого диалога.
          </span>
          <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={pending} onClick={onIntervene}>
            <Hand className="size-3.5" /> Вмешаться
          </Button>
        </div>
      )}
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
            Отредактируйте данные клиента или переназначьте диалог другому менеджеру.
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
