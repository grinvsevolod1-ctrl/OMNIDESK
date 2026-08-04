'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { MessageCircle } from 'lucide-react'
import { toast } from 'sonner'
import { markConversationReadAction } from '@/app/actions/account'
import {
  toggleConversationAiAction,
  acknowledgeAiHandoffAction,
  loadOlderMessagesAction,
  loadThreadMessagesAction,
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
import type { ForwardTarget } from '@/components/manager/message-context-menu'
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
import { cn } from '@/lib/utils'
import { LEAD_STATUS_OPTIONS, leadStatusOptionValue } from '@/lib/types'
import type {
  ChannelType,
  Conversation,
  LeadStatus,
  Message,
  NotLiquidReason,
  QuickReply,
} from '@/lib/types'
import { sourceLabel, type SortMode } from '@/components/manager/inbox/visual'
import { DetailsPanel } from '@/components/manager/inbox/atoms'
import { MessageComposer } from '@/components/manager/inbox/message-composer'
import { TransferDialog } from '@/components/manager/inbox/transfer-dialog'
import { useInboxRealtime } from '@/components/manager/inbox/use-inbox-realtime'
import { ConversationList } from '@/components/manager/inbox/conversation-list'
import { filterAndSortConversations } from '@/components/manager/inbox/filtering'
import { AiHandoffBanner } from '@/components/manager/inbox/ai-handoff-banner'
import { ThreadHeader } from '@/components/manager/inbox/thread-header'
import { MessageList } from '@/components/manager/inbox/message-list'
import { ComposerBanners } from '@/components/manager/inbox/composer-banners'
import { useThreadScroll } from '@/components/manager/inbox/use-thread-scroll'
import { useMessageActions } from '@/components/manager/inbox/use-message-actions'

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
  // Optimistic lead-status overrides (conversationId -> status snapshot).
  // Applied in the merge memo below so EVERY consumer (filters, labels, the
  // status dropdown) sees the new status instantly — this replaced a
  // router.refresh() that re-ran the whole inbox page (~8 DB queries) on
  // every single status change.
  const [statusOverrides, setStatusOverrides] = useState<
    Record<
      string,
      {
        status: LeadStatus
        statusDetail: NotLiquidReason | null
        statusManual: boolean
      }
    >
  >({})
  // Drop a status override once the server catches up (fresh props carry the
  // same status) so stale overrides can never mask NEWER server-side changes.
  useEffect(() => {
    // Returns the same reference when nothing changed — no cascading renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatusOverrides((prev) => {
      const ids = Object.keys(prev)
      if (ids.length === 0) return prev
      let changed = false
      const next = { ...prev }
      for (const id of ids) {
        const server = rawConversations.find((c) => c.id === id)
        if (
          server &&
          server.status === prev[id].status &&
          (server.statusDetail ?? null) === prev[id].statusDetail
        ) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [rawConversations])
  // Hide foreign account names: blank the channel name for any lead whose
  // channel this manager doesn't own, so the other account stays invisible.
  const conversations = useMemo(() => {
    const owned =
      ownedChannelIds.length > 0 ? new Set(ownedChannelIds) : null
    const hasStatusOverrides = Object.keys(statusOverrides).length > 0
    if (!owned && !hasStatusOverrides) return rawConversations
    return rawConversations.map((c) => {
      let next = c
      if (owned && !owned.has(c.channelId)) {
        next = { ...next, channelName: undefined }
      }
      const so = statusOverrides[c.id]
      if (so) {
        next = {
          ...next,
          status: so.status,
          statusDetail: so.statusDetail ?? undefined,
          statusManual: so.statusManual,
        }
      }
      return next
    })
  }, [rawConversations, ownedChannelIds, statusOverrides])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Per-conversation composer drafts. Like Telegram, an unsent message is kept
  // when you switch to another conversation and restored when you come back.
  // Kept in a ref (not state) so the MessageComposer — which is keyed by
  // conversation id and owns the live text in local state — can seed from and
  // write back to it WITHOUT ever re-rendering this large parent on a keystroke.
  //
  // Drafts are ALSO mirrored to localStorage: the in-memory ref dies with the
  // component (router.refresh storms, navigating away via a notification, a
  // full reload, a crash), and losing a half-written reply is exactly the
  // "текст исчезает" complaint. localStorage survives all of those. This is
  // ephemeral UI state (like Telegram Web's drafts), not app data.
  const draftsRef = useRef<Record<string, string>>({})
  const persistDraft = useCallback((id: string, text: string) => {
    if (text) draftsRef.current[id] = text
    else delete draftsRef.current[id]
    try {
      if (text) localStorage.setItem(`od_draft_${id}`, text)
      else localStorage.removeItem(`od_draft_${id}`)
    } catch {
      // Storage full / privacy mode — the in-memory copy still works.
    }
  }, [])
  const getDraft = useCallback((id: string) => {
    const inMemory = draftsRef.current[id]
    if (inMemory !== undefined) return inMemory
    try {
      return localStorage.getItem(`od_draft_${id}`) ?? ''
    } catch {
      return ''
    }
  }, [])
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
    // Optimistic: manual statuses update instantly through statusOverrides.
    // 'auto' means the SERVER recomputes the status — we can't know the result
    // client-side, so that (rare) branch is the only one that still refreshes.
    const prevOverride = statusOverrides[conversationId]
    if (status !== 'auto') {
      setStatusOverrides((prev) => ({
        ...prev,
        [conversationId]: {
          status,
          statusDetail: reason,
          statusManual: true,
        },
      }))
    }
    startStatusTransition(async () => {
      const res = await setLeadStatusAction(conversationId, status, reason)
      if (!res.ok) {
        toast.error(res.message)
        // Roll back the optimistic status on failure.
        if (status !== 'auto') {
          setStatusOverrides((prev) => {
            const next = { ...prev }
            if (prevOverride) next[conversationId] = prevOverride
            else delete next[conversationId]
            return next
          })
        }
        return
      }
      toast.success(res.message)
      if (status === 'auto') router.refresh()
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
      // No router.refresh(): the dismissedOverrides map already drives the
      // badge/sorting, and the server flag arrives with the next natural sync.
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
      // No router.refresh(): mutedOverrides already covers every consumer.
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
      // No router.refresh(): aiOverrides already drives the composer state.
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
      // No router.refresh(): the meeting-link message lands in the thread via
      // the SSE stream like any other outbound message.
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

  // Lazy hydration for threads outside the SSR preload slice: a missing key in
  // the map means "transcript not shipped yet" (an empty array means a genuinely
  // empty thread). First open fetches the recent history once.
  const [threadLoading, setThreadLoading] = useState(false)
  const hydratingRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeId || activeId in localMessages) return
    if (hydratingRef.current === activeId) return
    hydratingRef.current = activeId
    setThreadLoading(true)
    void loadThreadMessagesAction(activeId)
      .then((res) => {
        if (hydratingRef.current !== activeId) return
        setLocalMessages((prev) => {
          // An optimistic send may have created the key mid-flight — merge
          // the fetched history UNDER those messages instead of dropping it.
          const existing = prev[activeId]
          if (!existing || existing.length === 0)
            return { ...prev, [activeId]: res.ok ? res.messages : [] }
          if (!res.ok) return prev
          const known = new Set(existing.map((m) => m.id))
          const older = res.messages.filter((m) => !known.has(m.id))
          return older.length === 0
            ? prev
            : { ...prev, [activeId]: [...older, ...existing] }
        })
      })
      .catch(() => toast.error('Не удалось загрузить переписку'))
      .finally(() => {
        if (hydratingRef.current === activeId) {
          hydratingRef.current = null
          setThreadLoading(false)
        }
      })
  }, [activeId, localMessages])

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

  // NOTE: The outbound "agent is typing" indicator (a server action fired on
  // every keystroke) was removed for performance - a network round-trip per
  // character made the composer feel laggy. Typing is now purely local.

  // New message appended / visitor draft preview changed → follow, but only
  // when already at the bottom (see useThreadScroll).
  const activeTypingDraft =
    activeId && typingByConv[activeId] ? typingByConv[activeId].draft : ''

  // Thread auto-scroll (Telegram semantics) — owns the scroll container ref.
  const { messagesScrollRef, handleThreadScroll } = useThreadScroll({
    activeId,
    threadLength: thread.length,
    activeTypingDraft,
  })

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
  }, [activeId, loadingOlder, localMessages, messagesScrollRef])

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

  // Everything a manager can do to messages: send / reply / edit / react /
  // delete / forward / copy / stickers / media uploads, with optimistic
  // updates. Also owns the reply/edit target state.
  const {
    replyTarget,
    setReplyTarget,
    editTarget,
    setEditTarget,
    handleSend,
    reactTo,
    deleteMessage,
    forwardMessage,
    copyMessageText,
    sendSticker,
    handleSendMediaFile,
  } = useMessageActions({
    activeId,
    active,
    currentUser,
    activeAiLed,
    pulseAiButton,
    setLocalMessages,
    startTransition,
  })

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
      {/* AI hand-off banner — leads the AI promoted to «Ликвид» and handed
          to a human. Click to jump to the newest; opening a thread clears it. */}
      <AiHandoffBanner
        pendingHandoffs={pendingHandoffs}
        onOpen={setActiveId}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Conversation list                                                  */}
      {/* ------------------------------------------------------------------ */}
      <ConversationList
        active={Boolean(active)}
        activeId={activeId}
        setActiveId={setActiveId}
        setDetailsOpen={setDetailsOpen}
        totalCount={conversations.length}
        filtered={filtered}
        unreadTotal={unreadTotal}
        syncState={syncState}
        sortMode={sortMode}
        setSortMode={setSortMode}
        search={search}
        setSearch={setSearch}
        autopilot={autopilot}
        availableTypes={availableTypes}
        typeFilter={typeFilter}
        toggleType={toggleType}
        typeCounts={typeCounts}
        sources={sources}
        sourceFilter={sourceFilter}
        toggleSource={toggleSource}
        statusFilter={statusFilter}
        toggleStatus={toggleStatus}
        statusCounts={statusCounts}
        reasonFilter={reasonFilter}
        toggleReason={toggleReason}
        reasonCounts={reasonCounts}
        mutedCount={mutedCount}
        showMuted={showMuted}
        setShowMuted={setShowMuted}
        hasActiveFilters={hasActiveFilters}
        clearFilters={clearFilters}
        isMuted={isMuted}
        presenceByConv={presenceByConv}
        typingByConv={typingByConv}
        awaitingReply={awaitingReply}
        dismissedOverrides={dismissedOverrides}
        dismissReply={dismissReply}
        toggleMute={toggleMute}
        transferTargets={transferTargets}
        openTransfer={openTransfer}
        changeStatus={changeStatus}
      />

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
            <ThreadHeader
              active={active}
              activePresence={activePresence}
              activeAiLed={activeAiLed}
              aiButtonPulse={aiButtonPulse}
              statusPending={statusPending}
              activeStatusValue={activeStatusValue}
              hasTransferTargets={transferTargets.length > 0}
              onBack={() => setActiveId(null)}
              onOpenDetails={() => setDetailsOpen(true)}
              onToggleDetails={() => setDetailsOpen((v) => !v)}
              onToggleAi={() => toggleAi(active.id, !activeAiLed)}
              onChangeStatus={(v) => changeStatus(active.id, v)}
              onOpenTransfer={() => openTransfer(active.id)}
            />

            <MessageList
              active={active}
              activeId={activeId}
              thread={thread}
              threadLoading={threadLoading}
              noOlder={noOlder}
              loadingOlder={loadingOlder}
              onLoadOlder={handleLoadOlder}
              forwardTargets={forwardTargets}
              activeTyping={activeTyping}
              messagesScrollRef={messagesScrollRef}
              onThreadScroll={handleThreadScroll}
              onReply={(msg) => {
                setEditTarget(null)
                setReplyTarget(msg)
              }}
              onEdit={(msg) => {
                setReplyTarget(null)
                setEditTarget(msg)
              }}
              onReact={reactTo}
              onCopy={copyMessageText}
              onForward={forwardMessage}
              onDelete={deleteMessage}
              onShowHistory={setHistoryMessage}
            />

            <ComposerBanners
              editTarget={editTarget}
              replyTarget={replyTarget}
              onCancelEdit={() => setEditTarget(null)}
              onCancelReply={() => setReplyTarget(null)}
            />

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
              replyActive={!!replyTarget || !!editTarget}
              editing={
                editTarget ? { id: editTarget.id, body: editTarget.body } : null
              }
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
