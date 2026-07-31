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
  Filter,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Plus,
  Radio,
  Search,
} from 'lucide-react'
import {
  secretDeleteConversationAction,
  secretDeleteMessageAction,
  secretFetchThreadAction,
  secretListConversationsAction,
  secretSendAsClientAction,
  secretSendClientMediaAction,
  secretSetContactBlockedAction,
  secretSetConversationStatusAction,
  secretSetThreadSimAction,
  secretSetUnreadAction,
  type ConversationWithManager,
  type ConversationWithSim,
} from '@/app/actions/admin-secret'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { cn } from '@/lib/utils'
import type { Channel, Manager, Message } from '@/lib/types'
import {
  CONV_STATUS_LABEL,
  STATUS_VALUES,
  TYPE_LABEL,
  type DirFilter,
  type SimFilter,
  type SimInfo,
} from '@/components/admin/secret-console/utils'
import {
  CreateConversationDialog,
  EditConversationDialog,
} from '@/components/admin/secret-console/dialogs'
import {
  Composer,
  ConversationRow,
  MessageBubble,
  ThreadFilterBar,
  ThreadHeader,
} from '@/components/admin/secret-console/thread'

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
  // show the source filter (keeps the UI clean when nothing is simulated). Uses
  // the permanent is_simulated flag, so it stays correct for finished sims too.
  const hasAnySim = useMemo(
    () => conversations.some((c) => c.isSimulated),
    [conversations],
  )

  // Client-side filtered rail. Cheap, memoised, no refetch.
  const visibleConversations = useMemo(() => {
    return conversations.filter((c) => {
      if (unreadOnly && c.unread <= 0) return false
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      // Source axis (reliable, permanent).
      if (simFilter === 'sim' && !c.isSimulated) return false
      if (simFilter === 'real' && c.isSimulated) return false
      // Control axis (live autopilot state).
      if (simFilter === 'driving' && !(c.sim?.active && !c.sim.paused)) return false
      if (simFilter === 'paused' && !(c.sim?.active && c.sim.paused)) return false
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

  // Send a file AS THE CLIENT. Mirrors sendAsClient but ships bytes via
  // FormData; the current textarea text (if any) rides along as the caption.
  // `sendAs` lets a video be delivered as a round Telegram/VK-style "кружочек".
  const sendClientMedia = useCallback(
    (
      file: File,
      caption: string,
      onDone: () => void,
      sendAs?: 'video' | 'video_note',
    ) => {
      if (!selectedId) return
      const fd = new FormData()
      fd.append('file', file)
      if (caption.trim()) fd.append('caption', caption.trim())
      if (sendAs) fd.append('sendAs', sendAs)
      startTransition(async () => {
        const res = await secretSendClientMediaAction(selectedId, fd)
        if (res.ok && res.createdMessage) {
          const created = res.createdMessage
          setMessages((prev) =>
            prev.some((m) => m.id === created.id) ? prev : [...prev, created],
          )
          onDone()
          toast.success(res.message)
          if (res.simDetached) {
            setThreadSim((s) => (s ? { ...s, paused: true } : s))
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
                  <Label className="text-xs text-muted-foreground">Источник и ведение</Label>
                  <Select value={simFilter} onValueChange={(v) => setSimFilter((v as SimFilter) ?? 'all')}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все диалоги</SelectItem>
                      <SelectItem value="sim">С нашего сайта (симулятор)</SelectItem>
                      <SelectItem value="real">Реальные клиенты</SelectItem>
                      <SelectItem value="driving">Автопилот ведёт</SelectItem>
                      <SelectItem value="paused">На паузе (вы)</SelectItem>
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
              onSendMedia={sendClientMedia}
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
