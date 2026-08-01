'use client'

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  ChevronUp,
  History,
  Info,
  Loader2,
  BrainCircuit,
  MessageCircle,
  MoreVertical,
  Reply,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  markConversationReadAction,
  sendMessageAction,
  sendStickerAction,
  sendVkMediaAction,
  sendWhatsappMediaAction,
} from '@/app/actions/account'
import {
  replyMessageAction,
  reactMessageAction,
  deleteMessageAction,
  forwardMessageAction,
  toggleConversationAiAction,
  acknowledgeAiHandoffAction,
  loadOlderMessagesAction,
} from '@/app/actions/messages'
import {
  dismissReplyReminderAction,
  setConversationMutedAction,
  setLeadStatusAction,
} from '@/app/actions/leads'
import {
  createMeetingAction,
  transferConversationAction,
} from '@/app/actions/conversations'
import {
  MessageContextMenu,
  type ForwardTarget,
} from '@/components/manager/message-context-menu'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { AutopilotToggle } from '@/components/manager/autopilot-toggle'
// Edit-history is opened on demand (message context menu), so defer its JS and
// its SWR fetcher until an operator actually opens it — see the conditional
// render below, which only mounts it once historyMessage is set.
const EditHistoryDialog = dynamic(
  () =>
    import('@/components/manager/edit-history-dialog').then(
      (m) => m.EditHistoryDialog,
    ),
  { ssr: false },
)
import { VirtualList } from '@/components/manager/virtual-list'
import { cn } from '@/lib/utils'
import {
  LEAD_STATUS_META,
  LEAD_STATUS_OPTIONS,
  LEAD_STATUS_ORDER,
  NOT_LIQUID_REASON_META,
  NOT_LIQUID_REASON_ORDER,
  leadStatusOptionValue,
} from '@/lib/types'
import type {
  ChannelType,
  Conversation,
  LeadStatus,
  Message,
  NotLiquidReason,
  QuickReply,
  StickerItem,
} from '@/lib/types'
import {
  isMediaPlaceholder,
  MessageMedia,
} from '@/components/manager/inbox/message-media'
import {
  CHANNEL_VISUAL,
  LEAD_STATUS_VISUAL,
  FilterChip,
  dayLabel,
  listStamp,
  sourceLabel,
  timeShort,
  visitorTag,
  type SortMode,
} from '@/components/manager/inbox/visual'
import {
  ContactAvatar,
  DetailsPanel,
  DeliveryTicks,
  Highlight,
  PresenceBadge,
  PresenceDot,
  SourceChip,
  StatusChip,
  StatusRadioItems,
  SyncBadge,
} from '@/components/manager/inbox/atoms'
import { MessageComposer } from '@/components/manager/inbox/message-composer'
import { TransferDialog } from '@/components/manager/inbox/transfer-dialog'
import { useInboxRealtime } from '@/components/manager/inbox/use-inbox-realtime'
import { filterAndSortConversations } from '@/components/manager/inbox/filtering'





/* -------------------------------------------------------------------------- */
/*  Main component                                                            */
/* -------------------------------------------------------------------------- */


export function InboxView({
  conversations: rawConversations,
  messagesByConversation,
  currentUser,
  quickReplies = [],
  autopilot,
  aiMasterEnabled = false,
  ownedChannelIds = [],
  transferTargets = [],
  telemostEnabled = false,
}: {
  conversations: Conversation[]
  messagesByConversation: Record<string, Message[]>
  currentUser: string
  quickReplies?: QuickReply[]
  autopilot?: { enabled: boolean; enabledCount: number }
  /**
   * Global AI master switch (set on /admin/ai). When on, the AI leads every
   * conversation by default; a manager pauses individual threads to reply by
   * hand. Drives the blocked composer + "AI is leading" affordance.
   */
  aiMasterEnabled?: boolean
  /**
   * Channel ids this manager actually owns. Leads routed in from a shared/pool
   * account (e.g. while another manager was on lunch) keep a foreign channel —
   * we must NOT expose that account's name. Such leads appear as ordinary leads
   * with a generic channel-type label instead.
   */
  ownedChannelIds?: string[]
  /** Colleagues this manager can hand a conversation off to. */
  transferTargets?: { id: string; name: string; onLunch: boolean }[]
  /** Whether the Yandex Telemost video-meeting button is available. */
  telemostEnabled?: boolean
}) {
  const router = useRouter()
  // Hide foreign account names: blank the channel name for any lead whose
  // channel this manager doesn't own, so the other account stays invisible.
  const conversations = useMemo(() => {
    if (ownedChannelIds.length === 0) return rawConversations
    const owned = new Set(ownedChannelIds)
    return rawConversations.map((c) =>
      owned.has(c.channelId) ? c : { ...c, channelName: undefined },
    )
  }, [rawConversations, ownedChannelIds])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Per-conversation composer drafts. Like Telegram, an unsent message is kept
  // when you switch to another conversation and restored when you come back.
  // Kept in a ref (not state) so the MessageComposer — which is keyed by
  // conversation id and owns the live text in local state — can seed from and
  // write back to it WITHOUT ever re-rendering this large parent on a keystroke.
  const draftsRef = useRef<Record<string, string>>({})
  const persistDraft = useCallback((id: string, text: string) => {
    if (text) draftsRef.current[id] = text
    else delete draftsRef.current[id]
  }, [])
  const getDraft = useCallback((id: string) => draftsRef.current[id] ?? '', [])
  const [replyTarget, setReplyTarget] = useState<Message | null>(null)
  // Message whose edit history is open in the dialog (null = closed).
  const [historyMessage, setHistoryMessage] = useState<Message | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Conversation hand-off dialog state. `transferForId` holds the conversation
  // being handed off (null = dialog closed); the picker/note drive the submit.
  const [transferForId, setTransferForId] = useState<string | null>(null)
  const [transferTo, setTransferTo] = useState('')
  const [transferNote, setTransferNote] = useState('')
  const [transferPending, setTransferPending] = useState(false)
  // Telemost video-meeting creation in progress (disables the composer button).
  const [meetingPending, setMeetingPending] = useState(false)

  const [search, setSearch] = useState('')
  // Multi-select filters. An empty Set means "no filter" (show everything),
  // which keeps the common case cheap and avoids a magic 'all' sentinel.
  const [typeFilter, setTypeFilter] = useState<Set<ChannelType>>(
    () => new Set(),
  )
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(() => new Set())
  const [statusFilter, setStatusFilter] = useState<Set<LeadStatus>>(
    () => new Set(),
  )
  // «Не ликвид» reason refinement (Гео / -18 / NA / TRASH). When non-empty it
  // narrows the list to not-liquid leads matching the chosen reasons.
  const [reasonFilter, setReasonFilter] = useState<Set<NotLiquidReason>>(
    () => new Set(),
  )
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  // Toggle a value in/out of a Set-based filter (immutably, for React).
  const toggleType = useCallback((value: ChannelType) => {
    setTypeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])
  const toggleSource = useCallback((value: string) => {
    setSourceFilter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])
  const toggleStatus = useCallback((value: LeadStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])
  const toggleReason = useCallback((value: NotLiquidReason) => {
    setReasonFilter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])

  // Per-conversation message cache, patched live by the SSE handler. Declared
  // here (above the list memo) so sorting can detect threads whose last message
  // is inbound, i.e. still awaiting a manager reply.
  const [localMessages, setLocalMessages] = useState<
    Record<string, Message[]>
  >(messagesByConversation)

  // "Load older messages" state. Threads hydrate with only the most-recent
  // slice (see MESSAGE_HISTORY_LIMIT server-side); this lets a manager pull
  // older history on demand. `noOlder` marks threads with nothing left to load;
  // the scroll container ref preserves the reading position across a prepend.
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [noOlder, setNoOlder] = useState<Record<string, boolean>>({})
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)

  const handleLoadOlder = useCallback(async () => {
    if (!activeId || loadingOlder) return
    const current = localMessages[activeId] ?? []
    const oldest = current[0]
    if (!oldest) return
    setLoadingOlder(true)
    const container = messagesScrollRef.current
    const prevHeight = container?.scrollHeight ?? 0
    try {
      const before = new Date(oldest.createdAt).toISOString()
      const res = await loadOlderMessagesAction(activeId, before)
      if (res.ok && res.messages.length > 0) {
        setLocalMessages((prev) => {
          const existing = prev[activeId] ?? []
          const known = new Set(existing.map((m) => m.id))
          const older = res.messages.filter((m) => !known.has(m.id))
          if (older.length === 0) return prev
          return { ...prev, [activeId]: [...older, ...existing] }
        })
        // Keep the viewport anchored to the same message after older ones are
        // prepended above it (otherwise the list would jump to the top).
        requestAnimationFrame(() => {
          const c = messagesScrollRef.current
          if (c) c.scrollTop = c.scrollHeight - prevHeight
        })
      }
      if (!res.hasMore) setNoOlder((p) => ({ ...p, [activeId]: true }))
    } catch {
      toast.error('Не удалось загрузить историю')
    } finally {
      setLoadingOlder(false)
    }
  }, [activeId, loadingOlder, localMessages])

  // Optimistic "no reply needed" dismissals (conversationId -> dismissal time in
  // ms). Lets the badge/sorting update instantly before the server round-trip,
  // and is merged with the persisted `replyDismissedAt` from the server.
  const [dismissedOverrides, setDismissedOverrides] = useState<
    Record<string, number>
  >({})

  // Optimistic mute overrides (conversationId -> muted) so muting/unmuting
  // reflects instantly. Merged with the persisted `muted` flag from the server.
  const [mutedOverrides, setMutedOverrides] = useState<Record<string, boolean>>(
    {},
  )
  // Optimistic per-conversation AI-lead state, keyed by conversation id.
  const [aiOverrides, setAiOverrides] = useState<Record<string, boolean>>({})
  // Handoffs already acknowledged this session (guards the ack effect against
  // duplicate server calls). Not state: acknowledgement clears visually via the
  // "exclude the active thread" rule, and the server flag drives everything else.
  const ackedHandoffsRef = useRef<Record<string, boolean>>({})
  // Set true briefly to shake the AI button — the hint shown when a manager
  // tries to send while the AI is leading the thread.
  const [aiButtonPulse, setAiButtonPulse] = useState(false)
  const aiPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pulseAiButton = useCallback(() => {
    if (aiPulseTimer.current) clearTimeout(aiPulseTimer.current)
    setAiButtonPulse(true)
    aiPulseTimer.current = setTimeout(() => setAiButtonPulse(false), 600)
  }, [])
  // Whether to reveal muted/silenced threads in the list (hidden by default).
  const [showMuted, setShowMuted] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  // Latest values for the reminder interval to read without re-subscribing, plus
  // a per-conversation throttle so we never spam the same unanswered thread.
  const reminderRef = useRef<{
    conversations: Conversation[]
    awaiting: Map<string, { waiting: boolean; since: number }>
    activeId: string | null
    lastReminded: Map<string, number>
  }>({
    conversations: [],
    awaiting: new Map(),
    activeId: null,
    lastReminded: new Map(),
  })

  // Realtime: single /api/stream subscription + typing/presence state, patching
  // in-place message changes locally and debouncing everything else into one
  // router.refresh(). See useInboxRealtime for the full wiring.
  const { syncState, typingByConv, presenceByConv } = useInboxRealtime({
    router,
    setLocalMessages,
  })

  const typeCounts = useMemo(() => {
    const counts: Record<ChannelType, number> = {
      telegram: 0,
      whatsapp: 0,
      livechat: 0,
      max: 0,
      vk: 0,
    }
    for (const c of conversations) counts[c.channelType] += 1
    return counts
  }, [conversations])

  const statusCounts = useMemo(() => {
    const counts: Record<LeadStatus, number> = {
      unsubscribed: 0,
      handoff: 0,
      liquid: 0,
      not_liquid: 0,
      transferred: 0,
    }
    for (const c of conversations) counts[c.status] += 1
    return counts
  }, [conversations])

  const reasonCounts = useMemo(() => {
    const counts: Record<NotLiquidReason, number> = {
      geo: 0,
      under18: 0,
      na: 0,
      trash: 0,
    }
    for (const c of conversations) {
      if (c.status === 'not_liquid' && c.statusDetail)
        counts[c.statusDetail] += 1
    }
    return counts
  }, [conversations])

  const sources = useMemo(() => {
    const owned = ownedChannelIds.length > 0 ? new Set(ownedChannelIds) : null
    const map = new Map<
      string,
      { id: string; label: string; type: ChannelType; count: number }
    >()
    for (const c of conversations) {
      if (typeFilter.size > 0 && !typeFilter.has(c.channelType)) continue
      // Only the manager's own accounts are sortable sources; leads routed in
      // from a foreign/pool account stay as ordinary leads (no source entry).
      if (owned && !owned.has(c.channelId)) continue
      const existing = map.get(c.channelId)
      if (existing) existing.count += 1
      else
        map.set(c.channelId, {
          id: c.channelId,
          label: sourceLabel(c),
          type: c.channelType,
          count: 1,
        })
    }
    return Array.from(map.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    )
  }, [conversations, typeFilter, ownedChannelIds])

  // Effective mute state: optimistic override wins, else the persisted flag.
  const isMuted = useCallback(
    (c: Conversation) => mutedOverrides[c.id] ?? Boolean(c.muted),
    [mutedOverrides],
  )

  // For each conversation, work out whether it is still awaiting a manager reply
  // (the last message is inbound) and since when. Live-chat threads that have
  // been resolved are excluded. Falls back to the unread counter when a thread's
  // messages aren't cached yet. Drives both the "unread/unanswered on top"
  // sorting and the periodic "you haven't replied" reminder.
  const awaitingReply = useMemo(() => {
    const map = new Map<string, { waiting: boolean; since: number }>()
    for (const c of conversations) {
      const msgs = localMessages[c.id]
      let waiting: boolean
      let since: number
      if (msgs && msgs.length > 0) {
        const last = msgs[msgs.length - 1]
        waiting = last.direction === 'in'
        since = new Date(last.createdAt).getTime()
      } else {
        waiting = c.unread > 0
        since = new Date(c.lastMessageAt).getTime()
      }
      // A manual "no reply needed" dismissal silences the thread until a newer
      // inbound message arrives (since > dismissedAt reactivates it). We take the
      // max of the optimistic override and the persisted server timestamp.
      if (waiting) {
        const dismissedAt = Math.max(
          dismissedOverrides[c.id] ?? 0,
          c.replyDismissedAt ? new Date(c.replyDismissedAt).getTime() : 0,
        )
        if (dismissedAt >= since) waiting = false
      }
      // Muted contacts never count as awaiting a reply (no badge, no reminder).
      if (mutedOverrides[c.id] ?? Boolean(c.muted)) waiting = false
      map.set(c.id, { waiting, since })
    }
    return map
  }, [conversations, localMessages, dismissedOverrides, mutedOverrides])

  // How many muted threads exist (drives the "show silenced" toggle).
  const mutedCount = useMemo(
    () => conversations.filter((c) => isMuted(c)).length,
    [conversations, isMuted],
  )

  // Keep the reminder interval's snapshot fresh. Writing to the ref in an effect
  // (instead of during render) keeps this a proper post-render side-effect.
  useEffect(() => {
    reminderRef.current.conversations = conversations
    reminderRef.current.awaiting = awaitingReply
    reminderRef.current.activeId = activeId
  }, [conversations, awaitingReply, activeId])

  // Periodic nudge: if a contact's last message has gone unanswered for a while
  // and the manager isn't currently looking at that thread, pop a reminder toast.
  // Throttled per conversation so it nudges instead of nagging non-stop.
  useEffect(() => {
    const REMIND_AFTER_MS = 90_000 // grace period before the first nudge
    const REMIND_COOLDOWN_MS = 180_000 // re-nudge the same thread at most this often
    const TICK_MS = 30_000

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      const { conversations, awaiting, activeId, lastReminded } =
        reminderRef.current
      const now = Date.now()
      let pick: { id: string; name: string; since: number } | null = null
      for (const c of conversations) {
        if (c.id === activeId) continue // already on screen — no need to nag
        const a = awaiting.get(c.id)
        if (!a || !a.waiting) continue
        if (now - a.since < REMIND_AFTER_MS) continue
        if (now - (lastReminded.get(c.id) ?? 0) < REMIND_COOLDOWN_MS) continue
        // Surface the longest-waiting thread first.
        if (!pick || a.since < pick.since) {
          pick = { id: c.id, name: c.contactName, since: a.since }
        }
      }
      if (!pick) return
      reminderRef.current.lastReminded.set(pick.id, now)
      const waitedMin = Math.max(1, Math.round((now - pick.since) / 60_000))
      const picked = pick
      toast.warning(`Чувак, ты не ответил: ${picked.name}`, {
        description: `Сообщение ждёт ответа уже ${waitedMin} мин. Может, поднимешь жопу?`,
        duration: 10_000,
        action: {
          label: 'Открыть',
          onClick: () => setActiveId(picked.id),
        },
      })
    }

    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const filtered = useMemo(
    () =>
      filterAndSortConversations({
        conversations,
        search,
        typeFilter,
        sourceFilter,
        statusFilter,
        reasonFilter,
        sortMode,
        awaitingReply,
        isMuted,
        showMuted,
        activeId,
        localMessages,
      }),
    [
      conversations,
      search,
      sourceFilter,
      typeFilter,
      statusFilter,
      reasonFilter,
      sortMode,
      awaitingReply,
      isMuted,
      showMuted,
      activeId,
      localMessages,
    ],
  )

  // When the channel-type filter changes, drop any selected sources that no
  // longer belong to a visible type, so stale selections can't hide everything.
  useEffect(() => {
    if (typeFilter.size === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSourceFilter((prev) => {
      if (prev.size === 0) return prev
      const valid = new Set(
        conversations
          .filter((c) => typeFilter.has(c.channelType))
          .map((c) => c.channelId),
      )
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [typeFilter, conversations])

  const unreadTotal = useMemo(
    () => conversations.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0),
    [conversations],
  )

  // Keep the selection consistent with the current filter.
  useEffect(() => {
    const isDesktop =
      typeof window !== 'undefined' &&
      window.matchMedia('(min-width: 768px)').matches
    const stillVisible =
      activeId !== null && filtered.some((c) => c.id === activeId)
    /* eslint-disable react-hooks/set-state-in-effect */
    if (activeId !== null && !stillVisible) {
      setActiveId(isDesktop && filtered.length > 0 ? filtered[0].id : null)
      return
    }
    if (activeId === null && isDesktop && filtered.length > 0) {
      setActiveId(filtered[0].id)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [activeId, filtered])

  const [pending, startTransition] = useTransition()
  const [statusPending, startStatusTransition] = useTransition()

  // `optionValue` is either 'auto', a plain status, or 'not_liquid:<reason>'.
  function changeStatus(conversationId: string, optionValue: string) {
    let status: LeadStatus | 'auto' = 'auto'
    let reason: NotLiquidReason | null = null
    if (optionValue !== 'auto') {
      const opt = LEAD_STATUS_OPTIONS.find((o) => o.value === optionValue)
      if (opt) {
        status = opt.status
        reason = opt.reason ?? null
      } else {
        status = optionValue as LeadStatus
      }
    }
    startStatusTransition(async () => {
      const res = await setLeadStatusAction(conversationId, status, reason)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  // Mark a thread as "no reply needed" (or restore it). Optimistically stamps the
  // local override so the badge/sorting/reminders update instantly, then persists.
  function dismissReply(conversationId: string, clear = false) {
    setDismissedOverrides((prev) => {
      const next = { ...prev }
      if (clear) delete next[conversationId]
      else next[conversationId] = Date.now()
      return next
    })
    // Don't nag again about a thread we just dismissed.
    reminderRef.current.lastReminded.set(conversationId, Date.now())
    startStatusTransition(async () => {
      const res = await dismissReplyReminderAction(conversationId, clear)
      if (!res.ok) {
        toast.error(res.message)
        // Roll back the optimistic override on failure.
        setDismissedOverrides((prev) => {
          const next = { ...prev }
          delete next[conversationId]
          return next
        })
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  // Mute (silence) or unmute a contact, optimistically. Muted threads send no
  // notifications and are hidden from the default list.
  function toggleMute(conversationId: string, muted: boolean) {
    setMutedOverrides((prev) => ({ ...prev, [conversationId]: muted }))
    if (muted) reminderRef.current.lastReminded.set(conversationId, Date.now())
    startStatusTransition(async () => {
      const res = await setConversationMutedAction(conversationId, muted)
      if (!res.ok) {
        toast.error(res.message)
        // Roll back the optimistic override on failure.
        setMutedOverrides((prev) => {
          const next = { ...prev }
          delete next[conversationId]
          return next
        })
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  // Turn the AI manager-assistant on/off for the active conversation. When it's
  // switched on, the assistant re-reads the thread and leads from the next
  // inbound message; when the manager types a manual reply the server flips it
  // back off automatically (human takeover).
  function toggleAi(conversationId: string, enabled: boolean) {
    setAiOverrides((prev) => ({ ...prev, [conversationId]: enabled }))
    startStatusTransition(async () => {
      const res = await toggleConversationAiAction(conversationId, enabled)
      if (!res.ok) {
        toast.error(res.message)
        setAiOverrides((prev) => {
          const next = { ...prev }
          delete next[conversationId]
          return next
        })
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  // Open the hand-off dialog for a conversation, resetting the picker/note.
  function openTransfer(conversationId: string) {
    setTransferForId(conversationId)
    setTransferTo('')
    setTransferNote('')
  }

  // Submit the hand-off. On success the thread leaves this manager's inbox, so
  // we close it and refresh the server data.
  function submitTransfer() {
    if (!transferForId || !transferTo) {
      toast.error('Выберите менеджера для передачи.')
      return
    }
    const convId = transferForId
    setTransferPending(true)
    startStatusTransition(async () => {
      const res = await transferConversationAction(
        convId,
        transferTo,
        transferNote.trim() || undefined,
      )
      setTransferPending(false)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setTransferForId(null)
      if (activeId === convId) setActiveId(null)
      router.refresh()
    })
  }

  // Create a Yandex Telemost meeting and send the join link into the active
  // conversation via its own channel (handled server-side).
  function startVideoMeeting() {
    if (!activeId || meetingPending) return
    const convId = activeId
    setMeetingPending(true)
    startStatusTransition(async () => {
      const res = await createMeetingAction(convId)
      setMeetingPending(false)
      if (!res.ok) {
        // If the meeting was created but delivery failed, offer the link so it
        // isn't lost.
        if (res.joinUrl) {
          navigator.clipboard?.writeText(res.joinUrl).catch(() => {})
          toast.error(`${res.message} Ссылка скопирована в буфер обмена.`)
        } else {
          toast.error(res.message)
        }
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalMessages(messagesByConversation)
    // The fresh props carry only the most-recent slice again, so any previously
    // loaded older history is gone — reset the "nothing older" flags so the
    // load-older control reappears where applicable.
    setNoOlder({})
  }, [messagesByConversation])

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  )
  const thread = activeId ? (localMessages[activeId] ?? []) : []

  // Is the AI currently leading the open thread? Under global-lead mode the AI
  // leads whenever the master switch is on AND the thread isn't paused. An
  // optimistic override (from the inbox toggle) wins so the UI reacts instantly.
  const activeAiLed = useMemo(() => {
    if (!active) return false
    const override = aiOverrides[active.id]
    if (override !== undefined) return override
    return aiMasterEnabled && !active.aiPaused
  }, [active, aiOverrides, aiMasterEnabled])

  // Leads the AI just judged ready and handed off to a human («Ликвид»). Drives
  // the inbox banner + list highlight until the manager opens each thread.
  const pendingHandoffs = useMemo(
    () =>
      conversations.filter(
        (c) => c.aiHandoffPending && c.id !== activeId,
      ),
    [conversations, activeId],
  )

  // Auto-scroll the thread to the newest message (and as the visitor's live
  // typing draft grows, so the preview stays in view).
  const activeTypingDraft =
    activeId && typingByConv[activeId] ? typingByConv[activeId].draft : ''
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [activeId, thread.length, activeTypingDraft])

  // NOTE: The outbound "agent is typing" indicator (a server action fired on
  // every keystroke) was removed for performance - a network round-trip per
  // character made the composer feel laggy. Typing is now purely local.

  // Live "visitor is typing" state for the open thread (auto-expired by sweep).
  const activeTyping =
    activeId && typingByConv[activeId] ? typingByConv[activeId] : null

  // Live presence for the open thread (live-chat visitors only).
  const activePresence =
    activeId && presenceByConv[activeId]
      ? presenceByConv[activeId].state
      : null

  // Opening a conversation with unread messages marks it read on our side and
  // (for Telegram/WhatsApp) sends read receipts so the contact sees blue ticks.
  // The unread===0 guard makes this fire once per opened thread.
  useEffect(() => {
    if (!activeId) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv || conv.channelType === 'livechat' || conv.unread === 0) return
    void markConversationReadAction(activeId)
  }, [activeId, conversations])

  // Opening a thread the AI handed off («Ликвид») acknowledges it. The banner
  // and list highlight already exclude the active thread, so it clears visually
  // the instant it's opened - here we only clear the SERVER flag so it doesn't
  // return on refresh. A ref guard keeps this to one call per opened handoff.
  useEffect(() => {
    if (!activeId) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv?.aiHandoffPending || ackedHandoffsRef.current[activeId]) return
    ackedHandoffsRef.current[activeId] = true
    void acknowledgeAiHandoffAction(activeId)
  }, [activeId, conversations])

  // Called by the composer with the trimmed text. The composer owns the draft
  // and clears its own input after invoking this.
  function handleSend(text: string) {
    if (!activeId) return
    const body = text.trim()
    if (!body) return
    // While the AI is leading this thread, manual sends are blocked. Nudge the
    // manager to pause the AI first (the AI button vibrates as the hint).
    if (activeAiLed) {
      pulseAiButton()
      toast.error('ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.')
      return
    }
    const replyTo = replyTarget
    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      conversationId: activeId,
      direction: 'out',
      body,
      author: currentUser,
      createdAt: new Date().toISOString(),
      status: 'sent',
      ...(replyTo
        ? {
            replyTo: {
              id: replyTo.id,
              author: replyTo.author,
              body: replyTo.body,
              ...(replyTo.mediaType ? { mediaType: replyTo.mediaType } : {}),
            },
          }
        : {}),
    }
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: [...(prev[activeId] ?? []), optimistic],
    }))
    setReplyTarget(null)
    startTransition(async () => {
      const res =
        replyTo && active?.channelType === 'telegram'
          ? await replyMessageAction(activeId, replyTo.id, body)
          : await sendMessageAction(activeId, body)
      if (!res.ok) toast.error(res.message)
    })
  }

  /** Set (or clear) the operator's emoji reaction on a message, optimistically. */
  function reactTo(message: Message, emoji: string) {
    if (!activeId) return
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).map((m) => {
        if (m.id !== message.id) return m
        const others = (m.reactions ?? []).filter((r) => !r.fromMe)
        const reactions = emoji ? [...others, { emoji, fromMe: true }] : others
        return { ...m, reactions: reactions.length ? reactions : undefined }
      }),
    }))
    startTransition(async () => {
      const res = await reactMessageAction(message.id, emoji)
      if (!res.ok) toast.error(res.message)
    })
  }

  /** Soft-delete a message (revoke in Telegram), optimistically. */
  function deleteMessage(message: Message) {
    if (!activeId) return
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).map((m) =>
        m.id === message.id
          ? {
              ...m,
              body: '',
              deletedAt: new Date().toISOString(),
              reactions: undefined,
            }
          : m,
      ),
    }))
    startTransition(async () => {
      const res = await deleteMessageAction(message.id)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  /** Forward a message to another Telegram conversation. */
  function forwardMessage(message: Message, toConversationId: string) {
    startTransition(async () => {
      const res = await forwardMessageAction(message.id, toConversationId)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  /** Copy a message's text to the clipboard. */
  function copyMessageText(message: Message) {
    navigator.clipboard
      ?.writeText(message.body)
      .then(() => toast.success('Текст скопирован'))
      .catch(() => toast.error('Не удалось скопировать'))
  }

  function sendSticker(sticker: StickerItem) {
    if (!activeId) return
    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      conversationId: activeId,
      direction: 'out',
      body: sticker.emoji || '[Стикер]',
      author: currentUser,
      createdAt: new Date().toISOString(),
      status: 'sent',
      mediaType: 'sticker',
      mediaMime: sticker.mime,
    }
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: [...(prev[activeId] ?? []), optimistic],
    }))
    startTransition(async () => {
      const res = await sendStickerAction(activeId, sticker)
      if (!res.ok) toast.error(res.message)
    })
  }

  // Attach + send a file on a WhatsApp or VK conversation. The bytes are
  // uploaded provider-side (through the account's proxy); on success the realtime
  // insert (or refresh) shows the new message with its media bubble.
  function handleSendMediaFile(file: File, caption: string) {
    if (!activeId) return
    const channelType = active?.channelType
    if (channelType !== 'whatsapp' && channelType !== 'vk') return
    // Client-side guard so an over-large file fails with a clear message instead
    // of blowing past the Server Action body limit (which returns an opaque
    // framework error and would otherwise crash the inbox to the error page).
    // 200 MB matches the app's largest server-side allowance (VK docs).
    const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('Файл слишком большой (максимум 200 МБ).')
      return
    }
    const fd = new FormData()
    fd.append('file', file)
    const trimmed = caption.trim()
    if (trimmed) fd.append('caption', trimmed)
    startTransition(async () => {
      try {
        const res =
          channelType === 'vk'
            ? await sendVkMediaAction(activeId, fd)
            : await sendWhatsappMediaAction(activeId, fd)
        if (!res.ok) {
          toast.error(res.message)
        } else {
          toast.success(res.message)
          router.refresh()
        }
      } catch (err) {
        // Any transport/framework failure (e.g. body limit, dropped connection)
        // is contained here as a toast — never bubbled to the error boundary,
        // which would replace the whole inbox with the crash page.
        console.error('[v0] media upload failed:', err)
        toast.error('Не удалось отправить файл. Попробуйте ещё раз.')
      }
    })
  }

  // Clear any pending reply when switching conversations.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReplyTarget(null)
  }, [activeId])

  // Other Telegram conversations a message can be forwarded into.
  const forwardTargets: ForwardTarget[] = useMemo(
    () =>
      conversations
        .filter((c) => c.channelType === 'telegram' && c.id !== activeId)
        .map((c) => ({ id: c.id, name: c.contactName })),
    [conversations, activeId],
  )

  // Channel types that actually have chats — drives whether the "Тип" filter
  // menu is worth showing at all.
  const availableTypes = (
    ['telegram', 'whatsapp', 'livechat', 'max', 'vk'] as ChannelType[]
  ).filter((t) => typeCounts[t] > 0)

  const hasActiveFilters =
    typeFilter.size > 0 ||
    sourceFilter.size > 0 ||
    statusFilter.size > 0 ||
    reasonFilter.size > 0

  const clearFilters = useCallback(() => {
    setTypeFilter(new Set())
    setSourceFilter(new Set())
    setStatusFilter(new Set())
    setReasonFilter(new Set())
  }, [])

  const activeStatusValue =
    active && active.statusManual
      ? leadStatusOptionValue(active.status, active.statusDetail)
      : 'auto'

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-card">
      {/* ------------------------------------------------------------------ */}
      {/* AI hand-off banner — leads the AI promoted to «Ликвид» and handed   */}
      {/* to a human. Click to jump to the newest; opening a thread clears it. */}
      {/* ------------------------------------------------------------------ */}
      {pendingHandoffs.length > 0 ? (
        <button
          type="button"
          onClick={() => setActiveId(pendingHandoffs[0].id)}
          className="flex shrink-0 items-center gap-2.5 border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-left text-sm text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-emerald-50">
            <BrainCircuit className="size-3.5" />
          </span>
          <span className="flex-1 font-medium">
            {pendingHandoffs.length === 1
              ? `ИИ передал лид «${pendingHandoffs[0].contactName}» — готов к работе (Ликвид).`
              : `ИИ передал ${pendingHandoffs.length} лид(ов) — готовы к работе (Ликвид).`}
          </span>
          <span className="shrink-0 rounded-full bg-emerald-500 px-2.5 py-0.5 text-xs font-semibold text-emerald-50">
            Открыть
          </span>
        </button>
      ) : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Conversation list                                                  */}
      {/* ------------------------------------------------------------------ */}
      <div
        className={cn(
          'flex w-full flex-col border-r border-border md:w-[340px] md:shrink-0',
          active && 'hidden md:flex',
        )}
      >
        {/* Header */}
        <div className="flex flex-col gap-2.5 border-b border-border px-3 py-3">
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">Чаты</h2>
              {unreadTotal > 0 ? (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                  {unreadTotal}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <SyncBadge state={syncState} />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Фильтры и сортировка"
                    >
                      <SlidersHorizontal className="size-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Сортировка</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={sortMode}
                    onValueChange={(v) =>
                      setSortMode((v as SortMode) ?? 'recent')
                    }
                  >
                    <DropdownMenuRadioItem value="recent">
                      Сначала новые
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="oldest">
                      Сначала старые
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="unread">
                      По непрочитанным
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="status">
                      По статусу
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск по диалогам и сообщениям"
                  className="h-9 rounded-full border-transparent bg-muted pl-9 text-sm focus-visible:bg-card"
                  aria-label="Поиск по диалогам и сообщениям"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Очистить поиск"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>

          {/* Autopilot master switch (links to the full rule builder). Only
              rendered when the inbox page managed to read autopilot status. */}
          {autopilot ? (
            <AutopilotToggle
              initialEnabled={autopilot.enabled}
              enabledCount={autopilot.enabledCount}
            />
          ) : null}

          {/* Multi-select filter bar: hover-open menus with checkboxes. An empty
              selection means "no filter". Sources is shown only when more than
              one source is connected; channel type only when several types are
              present. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {availableTypes.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  openOnHover
                  delay={120}
                  render={
                    <FilterChip
                      label="Тип"
                      count={typeFilter.size}
                      active={typeFilter.size > 0}
                    />
                  }
                />
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuLabel>Тип канала</DropdownMenuLabel>
                  {availableTypes.map((t) => (
                    <DropdownMenuCheckboxItem
                      key={t}
                      checked={typeFilter.has(t)}
                      onCheckedChange={() => toggleType(t)}
                      closeOnClick={false}
                    >
                      <span className="flex flex-1 items-center gap-2">
                        <span
                          className={cn(
                            'size-2 rounded-full',
                            CHANNEL_VISUAL[t].dot,
                          )}
                        />
                        {CHANNEL_VISUAL[t].short}
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {typeCounts[t]}
                        </span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {sources.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  openOnHover
                  delay={120}
                  render={
                    <FilterChip
                      label="Источники"
                      count={sourceFilter.size}
                      active={sourceFilter.size > 0}
                    />
                  }
                />
                <DropdownMenuContent align="start" className="w-60">
                  <DropdownMenuLabel>Источники</DropdownMenuLabel>
                  {sources.map((s) => (
                    <DropdownMenuCheckboxItem
                      key={s.id}
                      checked={sourceFilter.has(s.id)}
                      onCheckedChange={() => toggleSource(s.id)}
                      closeOnClick={false}
                    >
                      <span className="flex flex-1 items-center gap-2">
                        <span
                          className={cn(
                            'size-2 rounded-full',
                            CHANNEL_VISUAL[s.type].dot,
                          )}
                        />
                        <span className="truncate">{s.label}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {s.count}
                        </span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger
                openOnHover
                delay={120}
                render={
                  <FilterChip
                    label="Статусы"
                    count={statusFilter.size}
                    active={statusFilter.size > 0}
                  />
                }
              />
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Статусы</DropdownMenuLabel>
                {LEAD_STATUS_ORDER.map((s) => (
                  <Fragment key={s}>
                    <DropdownMenuCheckboxItem
                      checked={statusFilter.has(s)}
                      onCheckedChange={() => toggleStatus(s)}
                      closeOnClick={false}
                    >
                      <span className="flex flex-1 items-center gap-2">
                        <span
                          className={cn(
                            'size-2 rounded-full',
                            LEAD_STATUS_VISUAL[s].dot,
                          )}
                        />
                        {LEAD_STATUS_META[s].label}
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {statusCounts[s]}
                        </span>
                      </span>
                    </DropdownMenuCheckboxItem>
                    {/* «Не ликвид» reason refinements (Гео / -18 / NA / TRASH) */}
                    {s === 'not_liquid'
                      ? NOT_LIQUID_REASON_ORDER.map((r) => (
                          <DropdownMenuCheckboxItem
                            key={r}
                            checked={reasonFilter.has(r)}
                            onCheckedChange={() => toggleReason(r)}
                            closeOnClick={false}
                            className="pl-8"
                          >
                            <span className="flex flex-1 items-center gap-2 text-xs">
                              {NOT_LIQUID_REASON_META[r].label}
                              <span className="ml-auto text-[10px] text-muted-foreground">
                                {reasonCounts[r]}
                              </span>
                            </span>
                          </DropdownMenuCheckboxItem>
                        ))
                      : null}
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {mutedCount > 0 ? (
              <button
                type="button"
                aria-pressed={showMuted}
                onClick={() => setShowMuted((v) => !v)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  showMuted
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                title={
                  showMuted
                    ? 'Скрыть заглушённые контакты'
                    : 'Показать заглушённые контакты'
                }
              >
                <BellOff className="size-3" />
                {showMuted ? 'Скрыть заглушённые' : 'Заглушённые'}
                <span className="text-[10px] opacity-60">{mutedCount}</span>
              </button>
            ) : null}

            {hasActiveFilters ? (
              <button
                type="button"
                onClick={clearFilters}
                className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3" />
                Сбросить
              </button>
            ) : null}
          </div>
        </div>

        {/* List (virtualized — only near-viewport rows are mounted; see VirtualList) */}
        {filtered.length === 0 ? (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {conversations.length === 0
                ? 'Пока нет диалогов.'
                : 'Ничего не найдено по фильтрам.'}
            </p>
          </div>
        ) : (
          <VirtualList
            items={filtered}
            getItemKey={(c) => c.id}
            estimateSize={76}
            className="scrollbar-thin min-h-0 flex-1 px-1.5 py-1.5"
            renderItem={(c) => (
              <ContextMenu key={c.id}>
                <ContextMenuTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => setActiveId(c.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-[background-color,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-muted/60 active:scale-[0.985]',
                        activeId === c.id
                          ? 'bg-secondary hover:bg-secondary'
                          : '',
                        c.aiHandoffPending && activeId !== c.id
                          ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/40 hover:bg-emerald-500/15'
                          : '',
                      )}
                    />
                  }
                >
                  <ContactAvatar
                    name={c.contactName}
                    channel={c.channelType}
                    channelId={c.channelId}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className={cn(
                          'flex min-w-0 items-center gap-1 truncate text-sm',
                          c.unread > 0 ? 'font-semibold' : 'font-medium',
                        )}
                      >
                        {isMuted(c) ? (
                          <BellOff className="size-3 shrink-0 text-muted-foreground" />
                        ) : null}
                        {presenceByConv[c.id] ? (
                          <PresenceDot state={presenceByConv[c.id].state} />
                        ) : null}
                        <Highlight text={c.contactName} query={search} />
                        {visitorTag(c) ? (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-medium tabular-nums text-muted-foreground">
                            {visitorTag(c)}
                          </span>
                        ) : null}
                      </p>
                      <span
                        className={cn(
                          'shrink-0 text-[11px]',
                          c.unread > 0
                            ? 'font-medium text-primary'
                            : 'text-muted-foreground',
                        )}
                      >
                        {listStamp(c.lastMessageAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      {typingByConv[c.id] ? (
                        <p className="truncate text-xs font-medium text-primary">
                          печатает…
                        </p>
                      ) : (
                        <p
                          className={cn(
                            'truncate text-xs',
                            c.unread > 0
                              ? 'text-foreground/80'
                              : 'text-muted-foreground',
                          )}
                        >
                          <Highlight text={c.lastMessage} query={search} />
                        </p>
                      )}
                      {c.unread > 0 ? (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                          {c.unread}
                        </span>
                      ) : awaitingReply.get(c.id)?.waiting ? (
                        <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          <Reply className="size-3" />
                          ждёт ответа
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          LEAD_STATUS_VISUAL[c.status].dot,
                        )}
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {LEAD_STATUS_META[c.status].label}
                        {!c.statusManual ? ' · авто' : ''}
                      </span>
                      <SourceChip
                        conversation={c}
                        size="xs"
                        className="ml-auto max-w-[45%]"
                      />
                    </div>
                  </div>
                </ContextMenuTrigger>

                <ContextMenuContent>
                  <ContextMenuLabel>{c.contactName}</ContextMenuLabel>
                  <ContextMenuItem
                    onClick={() => {
                      setActiveId(c.id)
                      setDetailsOpen(true)
                    }}
                  >
                    <Info className="size-4" />
                    Данные и источник
                  </ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Tag className="size-4" />
                      Статус лида
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuRadioGroup
                        value={
                          c.statusManual
                            ? leadStatusOptionValue(c.status, c.statusDetail)
                            : 'auto'
                        }
                        onValueChange={(v) => changeStatus(c.id, v ?? 'auto')}
                      >
                        <StatusRadioItems Item={ContextMenuRadioItem} />
                      </ContextMenuRadioGroup>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                  {awaitingReply.get(c.id)?.waiting ? (
                    <ContextMenuItem onClick={() => dismissReply(c.id)}>
                      <Check className="size-4" />
                      Не требует ответа
                    </ContextMenuItem>
                  ) : c.unread === 0 &&
                    (dismissedOverrides[c.id] || c.replyDismissedAt) ? (
                    <ContextMenuItem onClick={() => dismissReply(c.id, true)}>
                      <Reply className="size-4" />
                      Вернуть в ожидающие
                    </ContextMenuItem>
                  ) : null}
                  {isMuted(c) ? (
                    <ContextMenuItem onClick={() => toggleMute(c.id, false)}>
                      <Bell className="size-4" />
                      Включить уведомления
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem onClick={() => toggleMute(c.id, true)}>
                      <BellOff className="size-4" />
                      Заглушить контакт
                    </ContextMenuItem>
                  )}
                    {transferTargets.length > 0 ? (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => openTransfer(c.id)}>
                          <UserPlus className="size-4" />
                          Передать менеджеру
                        </ContextMenuItem>
                      </>
                    ) : null}
                  </ContextMenuContent>
                </ContextMenu>
            )}
          />
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Thread                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          !active && 'hidden md:flex',
        )}
      >
        {active ? (
          <>
            {/* Thread header */}
            <div className="flex h-14 items-center gap-3 border-b border-border px-3 sm:px-4">
              <Button
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                onClick={() => setActiveId(null)}
                aria-label="Назад к списку"
              >
                <ArrowLeft className="size-4" />
              </Button>
              <button
                type="button"
                onClick={() => setDetailsOpen(true)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-label="Открыть данные о контакте"
              >
                <ContactAvatar
                  name={active.contactName}
                  channel={active.channelType}
                  channelId={active.channelId}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="flex items-center gap-2 truncate text-sm font-semibold">
                    {active.contactName}
                    {visitorTag(active) ? (
                      <span className="shrink-0 rounded bg-muted px-1 text-[11px] font-medium tabular-nums text-muted-foreground">
                        {visitorTag(active)}
                      </span>
                    ) : null}
                    {activePresence ? (
                      <PresenceBadge state={activePresence} />
                    ) : null}
                  </p>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <SourceChip conversation={active} size="xs" />
                  </div>
                </div>
              </button>

              <div className="flex items-center gap-1.5">
                <Button
                  variant={activeAiLed ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => toggleAi(active.id, !activeAiLed)}
                  disabled={statusPending}
                  aria-pressed={activeAiLed}
                  title={
                    activeAiLed
                      ? 'ИИ ведёт этот диалог. Нажмите, чтобы отключить и ответить самому.'
                      : 'Включить ИИ: он проанализирует переписку и продолжит общение.'
                  }
                  className={cn(
                    'gap-1.5',
                    aiButtonPulse && 'animate-shake ring-2 ring-primary',
                  )}
                >
                  <BrainCircuit className="size-4" />
                  <span className="hidden sm:inline">
                    {activeAiLed ? 'ИИ ведёт' : 'ИИ'}
                  </span>
                </Button>
                <StatusChip
                  status={active.status}
                  auto={!active.statusManual}
                  className="hidden sm:inline-flex"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDetailsOpen((v) => !v)}
                  aria-label="Данные о контакте"
                  className="hidden md:inline-flex"
                >
                  <Info className="size-4" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Действия с диалогом"
                      >
                        <MoreVertical className="size-4" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuLabel>Статус лида</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={activeStatusValue}
                      onValueChange={(v) => changeStatus(active.id, v ?? 'auto')}
                    >
                      <StatusRadioItems
                        Item={
                          DropdownMenuRadioItem as unknown as typeof ContextMenuRadioItem
                        }
                      />
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setDetailsOpen(true)}>
                      <Info className="size-4" />
                      Данные и источник
                    </DropdownMenuItem>
                    {transferTargets.length > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => openTransfer(active.id)}>
                          <UserPlus className="size-4" />
                          Передать менеджеру
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Messages */}
            <div
              ref={messagesScrollRef}
              className="scrollbar-thin min-h-0 flex-1 overflow-y-auto bg-muted/20 px-3 py-4 sm:px-6"
              style={{
                backgroundImage:
                  'radial-gradient(color-mix(in oklch, var(--foreground) 5%, transparent) 1px, transparent 1px)',
                backgroundSize: '22px 22px',
              }}
            >
              <div className="mx-auto flex max-w-3xl flex-col gap-1">
                {/* Older-history loader: shown only when the thread was truncated
                    to the most-recent slice and there may be more to fetch. */}
                {activeId && thread.length >= 300 && !noOlder[activeId] ? (
                  <div className="mb-2 flex justify-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleLoadOlder}
                      disabled={loadingOlder}
                      className="gap-1.5 text-xs text-muted-foreground"
                    >
                      {loadingOlder ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <ChevronUp className="size-3.5" />
                      )}
                      Загрузить ранние сообщения
                    </Button>
                  </div>
                ) : null}
                {thread.map((m, i) => {
                  const prev = thread[i - 1]
                  const showDay =
                    !prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt)
                  const isOut = m.direction === 'out'
                  const prevSameSide =
                    prev && prev.direction === m.direction && !showDay
                  return (
                    // content-visibility lets the browser skip layout/paint of
                    // off-screen bubbles — a large win on 300-message threads.
                    <div
                      key={m.id}
                      style={{
                        contentVisibility: 'auto',
                        containIntrinsicSize: 'auto 56px',
                      }}
                    >
                      {showDay ? (
                        <div className="my-3 flex justify-center">
                          <span className="rounded-full bg-card/90 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border/50">
                            {dayLabel(m.createdAt)}
                          </span>
                        </div>
                      ) : null}
                      <div
                        className={cn(
                          'flex',
                          isOut ? 'justify-end' : 'justify-start',
                          prevSameSide ? 'mt-0.5' : 'mt-2',
                        )}
                      >
                        {(() => {
                          const isDeleted = Boolean(m.deletedAt)
                          // Deleted messages KEEP their content; we just append a
                          // marker so nothing is lost. Label reflects who deleted
                          // it (the contact vs. us), defaulting when unknown.
                          const deletedLabel = isDeleted
                            ? m.deletedOrigin === 'self'
                              ? 'Вы удалили это сообщение'
                              : m.deletedOrigin === 'remote'
                                ? 'Удалено собеседником'
                                : 'Сообщение удалено'
                            : null
                          // Stickers render even without a URL (optimistic
                          // outgoing ones fall back to their emoji).
                          const hasMedia = Boolean(
                            m.mediaType &&
                              (m.mediaUrl || m.mediaType === 'sticker'),
                          )
                          // Stickers float free (no bubble chrome); everything
                          // else keeps the normal bubble styling.
                          const bare = m.mediaType === 'sticker'
                          // Hide the text body for stickers (the sticker itself
                          // conveys it) and for synthetic media placeholders.
                          const showBody =
                            m.body &&
                            m.mediaType !== 'sticker' &&
                            !(hasMedia && isMediaPlaceholder(m.body))
                          const canAct = active.channelType === 'telegram'
                          const reactions = m.reactions ?? []

                          const bubble = (
                            <div
                              className={cn(
                                'text-sm',
                                bare
                                  ? ''
                                  : cn(
                                      'px-3 py-2 shadow-sm',
                                      isOut
                                        ? 'rounded-2xl rounded-br-sm bg-primary text-primary-foreground'
                                        : 'rounded-2xl rounded-bl-sm border border-border bg-card text-foreground',
                                    ),
                              )}
                            >
                              {!isOut && m.author && !prevSameSide ? (
                                <p
                                  className={cn(
                                    'mb-0.5 text-[11px] font-semibold',
                                    CHANNEL_VISUAL[active.channelType].accentText,
                                  )}
                                >
                                  {m.author}
                                </p>
                              ) : null}
                              {m.replyTo ? (
                                <div
                                  className={cn(
                                    'mb-1 rounded-md border-l-2 px-2 py-1 text-left text-xs',
                                    isOut
                                      ? 'border-primary-foreground/50 bg-primary-foreground/10'
                                      : 'border-primary/60 bg-muted/60',
                                  )}
                                >
                                  <p className="font-semibold opacity-90">
                                    {m.replyTo.author || 'Сообщение'}
                                  </p>
                                  <p className="truncate opacity-75">
                                    {m.replyTo.body ||
                                      (m.replyTo.mediaType ? '[вложение]' : '')}
                                  </p>
                                </div>
                              ) : null}
                              {hasMedia ? (
                                <div
                                  className={cn(
                                    showBody && !bare ? 'mb-1' : '',
                                    // Dim preserved media when the message was
                                    // deleted, but keep it openable/saveable.
                                    isDeleted ? 'opacity-60' : '',
                                  )}
                                >
                                  <MessageMedia message={m} />
                                </div>
                              ) : null}
                              {deletedLabel ? (
                                <p
                                  className={cn(
                                    'mb-0.5 flex items-center gap-1 text-[11px] font-medium italic',
                                    isOut
                                      ? 'text-primary-foreground/80'
                                      : 'text-muted-foreground',
                                  )}
                                >
                                  <Trash2 className="size-3 shrink-0" />
                                  {deletedLabel}
                                </p>
                              ) : null}
                              <div className="flex flex-wrap items-end justify-end gap-x-2">
                                {showBody ? (
                                  <p
                                    className={cn(
                                      'whitespace-pre-wrap break-words text-left leading-relaxed [overflow-wrap:anywhere]',
                                      isDeleted ? 'italic opacity-60' : '',
                                    )}
                                  >
                                    {m.body}
                                  </p>
                                ) : null}
                                <span
                                  className={cn(
                                    'ml-auto flex shrink-0 items-center gap-0.5 text-[10px] leading-none',
                                    bare
                                      ? 'text-muted-foreground'
                                      : isOut
                                        ? 'text-primary-foreground/70'
                                        : 'text-muted-foreground',
                                  )}
                                >
                                  {m.editedAt ? (
                                    <button
                                      type="button"
                                      onClick={() => setHistoryMessage(m)}
                                      title="Показать историю изменений"
                                      className={cn(
                                        'mr-0.5 flex items-center gap-0.5 rounded px-0.5 italic underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-80',
                                        isOut
                                          ? 'text-primary-foreground/70'
                                          : 'text-muted-foreground',
                                      )}
                                    >
                                      <History className="size-2.5" />
                                      изменено
                                    </button>
                                  ) : null}
                                  {timeShort(m.createdAt)}
                                  {isOut ? <DeliveryTicks status={m.status} /> : null}
                                </span>
                              </div>
                            </div>
                          )

                          return (
                            <div
                              className={cn(
                                'flex max-w-[80%] flex-col gap-1 sm:max-w-[70%]',
                                isOut ? 'items-end' : 'items-start',
                              )}
                            >
                              {canAct ? (
                                <MessageContextMenu
                                  message={m}
                                  forwardTargets={forwardTargets}
                                  onReply={(msg) => setReplyTarget(msg)}
                                  onReact={reactTo}
                                  onCopy={copyMessageText}
                                  onForward={forwardMessage}
                                  onDelete={deleteMessage}
                                >
                                  {bubble}
                                </MessageContextMenu>
                              ) : (
                                bubble
                              )}
                              {reactions.length ? (
                                <div
                                  className={cn(
                                    'flex flex-wrap gap-1',
                                    isOut ? 'justify-end' : 'justify-start',
                                  )}
                                >
                                  {reactions.map((r, ri) => (
                                    <button
                                      key={`${r.emoji}_${ri}`}
                                      type="button"
                                      onClick={() =>
                                        canAct &&
                                        reactTo(m, r.fromMe ? '' : r.emoji)
                                      }
                                      className={cn(
                                        'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs ring-1 transition-colors',
                                        r.fromMe
                                          ? 'bg-primary/15 ring-primary/40'
                                          : 'bg-muted ring-border',
                                      )}
                                      aria-label={`Реакция ${r.emoji}`}
                                    >
                                      <span>{r.emoji}</span>
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  )
                })}
                {activeTyping ? (
                  <div className="flex flex-col items-start gap-1">
                    <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-3 py-2">
                      <span className="inline-flex gap-1" aria-hidden>
                        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {activeTyping.name} печатает
                      </span>
                    </div>
                    {activeTyping.draft ? (
                      <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-dashed border-border bg-card px-3 py-2 text-sm italic text-muted-foreground">
                        {activeTyping.draft}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Reply preview banner */}
            {replyTarget ? (
              <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-2">
                <Reply className="size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2">
                  <p className="text-xs font-semibold text-primary">
                    Ответ · {replyTarget.author || 'Сообщение'}
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
                  onClick={() => setReplyTarget(null)}
                  aria-label="Отменить ответ"
                >
                  <X className="size-4" />
                </Button>
              </div>
            ) : null}

            {/* Composer — isolated component so typing never re-renders the
                whole inbox. Keyed by conversation id so each thread gets its own
                local draft (persisted across switches via draftsRef). */}
            <MessageComposer
              key={active.id}
              conversationId={active.id}
              channelType={active.channelType}
              channelId={active.channelId}
              getInitialDraft={getDraft}
              onPersistDraft={(text) => persistDraft(active.id, text)}
              onSend={handleSend}
              onSendSticker={sendSticker}
              onSendMediaFile={handleSendMediaFile}
              aiLed={activeAiLed}
              onBlockedInteract={() => {
                pulseAiButton()
                toast.error(
                  'ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.',
                )
              }}
              onToggleAi={() => toggleAi(active.id, false)}
              statusPending={statusPending}
              pending={pending}
              quickReplies={quickReplies}
              telemostEnabled={telemostEnabled}
              onStartMeeting={startVideoMeeting}
              meetingPending={meetingPending}
              replyActive={!!replyTarget}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-muted">
              <MessageCircle className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Выберите диалог</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Откройте чат слева, чтобы прочитать переписку и ответить. Правый
              клик по диалогу — быстрые действия.
            </p>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Details drawer (overlays the thread)                               */}
      {/* ------------------------------------------------------------------ */}
      {active && detailsOpen ? (
        <button
          type="button"
          className="absolute inset-0 z-10 cursor-default bg-foreground/10 md:hidden"
          aria-label="Закрыть панель данных"
          onClick={() => setDetailsOpen(false)}
        />
      ) : null}
      <aside
        className={cn(
          'absolute inset-y-0 right-0 z-20 w-full max-w-sm border-l border-border bg-card shadow-xl transition-transform duration-200 ease-out md:w-80',
          active && detailsOpen
            ? 'translate-x-0'
            : 'pointer-events-none translate-x-full',
        )}
        aria-hidden={!(active && detailsOpen)}
      >
        {active ? (
          <DetailsPanel
            key={active.id}
            conversation={active}
            onClose={() => setDetailsOpen(false)}
            onStatus={(next) => changeStatus(active.id, next)}
            statusPending={statusPending}
          />
        ) : null}
      </aside>
      </div>

      {/* Hand-off dialog: pick a colleague and optionally leave a note. */}
      <TransferDialog
        open={transferForId !== null}
        onClose={() => setTransferForId(null)}
        targets={transferTargets}
        selectedId={transferTo}
        onSelect={setTransferTo}
        note={transferNote}
        onNoteChange={setTransferNote}
        pending={transferPending}
        onSubmit={submitTransfer}
      />

      {historyMessage && (
        <EditHistoryDialog
          messageId={historyMessage.id}
          currentBody={historyMessage.body ?? ''}
          currentMediaType={historyMessage.mediaType}
          currentMediaUrl={historyMessage.mediaUrl}
          onOpenChange={(open) => {
            if (!open) setHistoryMessage(null)
          }}
        />
      )}
    </div>
  )
}
