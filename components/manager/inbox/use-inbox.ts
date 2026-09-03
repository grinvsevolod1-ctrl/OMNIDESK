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
import { markConversationReadAction } from '@/app/actions/account'
import { acknowledgeAiHandoffAction } from '@/app/actions/messages'
import { leadStatusOptionValue } from '@/lib/types'
import type { ChannelType, Conversation, Message } from '@/lib/types'
import { useInboxFilters } from '@/components/manager/inbox/use-inbox-filters'
import { useDrafts } from '@/components/manager/inbox/use-drafts'
import { useInboxRealtime } from '@/components/manager/inbox/use-inbox-realtime'
import { filterAndSortConversations } from '@/components/manager/inbox/filtering'
import { useReplyReminder } from '@/components/manager/inbox/use-reply-reminder'
import { useThreadHistory } from '@/components/manager/inbox/use-thread-history'
import { useThreadScroll } from '@/components/manager/inbox/use-thread-scroll'
import { useMessageActions } from '@/components/manager/inbox/use-message-actions'
import { useConversationActions } from '@/components/manager/inbox/use-conversation-actions'
import { useTransferMeeting } from '@/components/manager/inbox/use-transfer-meeting'
import { useInboxDerived } from '@/components/manager/inbox/use-inbox-derived'

export interface UseInboxParams {
  conversations: Conversation[]
  messagesByConversation: Record<string, Message[]>
  currentUser: string
  aiMasterEnabled: boolean
  ownedChannelIds: string[]
}

/**
 * Orchestrates the entire inbox: selection, drafts, optimistic conversation
 * actions, hand-off/meeting flow, filtering + sorting, realtime patching,
 * derived counters, reply reminders, thread hydration/scroll and all message
 * actions. Returns a flat bag consumed by the presentational InboxView. The
 * ordering of the hook calls matters (a couple of refs break render cycles) —
 * it mirrors the original single-file component exactly.
 */
export function useInbox({
  conversations: rawConversations,
  messagesByConversation,
  currentUser,
  aiMasterEnabled,
  ownedChannelIds,
}: UseInboxParams) {
  const router = useRouter()
  const [activeId, setActiveId] = useState<string | null>(null)
  // Per-conversation composer drafts (in-memory + localStorage mirror).
  const { persistDraft, getDraft } = useDrafts()
  // Message whose edit history is open in the dialog (null = closed).
  const [historyMessage, setHistoryMessage] = useState<Message | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  // useReplyReminder needs awaitingReply (derived below), while dismiss/mute
  // actions need snoozeReminder — the ref breaks that cycle. Filled after
  // useReplyReminder runs.
  const snoozeReminderRef = useRef<(conversationId: string) => void>(() => {})

  // Optimistic conversation overrides + all status/mute/AI actions.
  const {
    conversations,
    statusPending,
    startStatusTransition,
    dismissedOverrides,
    mutedOverrides,
    aiOverrides,
    isMuted,
    changeStatus,
    dismissReply,
    toggleMute,
    toggleAi,
  } = useConversationActions({
    rawConversations,
    ownedChannelIds,
    router,
    snoozeReminderRef,
  })

  // Hand-off dialog + Telemost meeting creation.
  const {
    transferForId,
    setTransferForId,
    transferTo,
    setTransferTo,
    transferNote,
    setTransferNote,
    transferPending,
    meetingPending,
    openTransfer,
    submitTransfer,
    startVideoMeeting,
  } = useTransferMeeting({
    router,
    activeId,
    setActiveId,
    startStatusTransition,
  })

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

  // List filtering + sorting state (search, Set filters, sort mode).
  const {
    search,
    setSearch,
    typeFilter,
    toggleType,
    sourceFilter,
    toggleSource,
    pruneSources,
    statusFilter,
    toggleStatus,
    reasonFilter,
    toggleReason,
    sortMode,
    setSortMode,
    hasActiveFilters,
    clearFilters,
  } = useInboxFilters()

  // Per-conversation message cache, patched live by the SSE handler. Declared
  // here (above the derived memo) so sorting can detect threads whose last
  // message is inbound, i.e. still awaiting a manager reply.
  const [localMessages, setLocalMessages] = useState<
    Record<string, Message[]>
  >(messagesByConversation)

  // Realtime: single /api/stream subscription + typing/presence state, patching
  // in-place message changes locally and debouncing everything else into one
  // router.refresh(). See useInboxRealtime for the full wiring.
  const { syncState, typingByConv, presenceByConv } = useInboxRealtime({
    router,
    setLocalMessages,
  })

  // Counters, sources, awaiting-reply map, forward targets, handoffs.
  const {
    typeCounts,
    statusCounts,
    reasonCounts,
    sources,
    awaitingReply,
    mutedCount,
    unreadTotal,
    forwardTargets,
    pendingHandoffs,
  } = useInboxDerived({
    conversations,
    localMessages,
    dismissedOverrides,
    mutedOverrides,
    typeFilter,
    ownedChannelIds,
    isMuted,
    activeId,
  })

  // Periodic "you have not replied" toast for waiting threads (see hook).
  const { snoozeReminder } = useReplyReminder({
    conversations,
    awaitingReply,
    activeId,
    onOpen: setActiveId,
  })
  useEffect(() => {
    snoozeReminderRef.current = snoozeReminder
  }, [snoozeReminder])

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
    const valid = new Set(
      conversations
        .filter((c) => typeFilter.has(c.channelType))
        .map((c) => c.channelId),
    )
    pruneSources(valid)
  }, [typeFilter, conversations, pruneSources])

  // Keep the selection consistent with the current filter. Deliberately NO
  // auto-select: nothing opens until the manager clicks a dialog (like
  // Telegram) — the previous version force-opened the first thread on desktop,
  // which also marked it read as a side effect. If the active thread is
  // filtered out, just close it back to the empty state.
  useEffect(() => {
    if (activeId !== null && !filtered.some((c) => c.id === activeId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveId(null)
    }
  }, [activeId, filtered])

  // Esc closes the open dialog back to the empty state — but never fights the
  // layered UI: overlays (details drawer, transfer/history dialogs) take Esc
  // first, and a focused text field keeps its own Esc (draft/reply cancel).
  useEffect(() => {
    if (activeId === null) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (transferForId !== null || historyMessage !== null) return
      const el = document.activeElement
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable)
      )
        return
      if (detailsOpen) {
        setDetailsOpen(false)
        return
      }
      setActiveId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeId, detailsOpen, transferForId, historyMessage])

  const [pending, startTransition] = useTransition()

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

  // Лид передан куратору (миграция 151): менеджер видит переписку только для
  // чтения — композер блокируется, передача/AI-переключатель скрываются, из
  // напоминаний диалог исключается. Ответственность за общение у куратора.
  const activeTransferred = Boolean(active?.transferred)

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

  // Lazy thread hydration + on-demand older-history loading (see hook).
  const { threadLoading, loadingOlder, noOlder, setNoOlder, handleLoadOlder } =
    useThreadHistory({
      activeId,
      localMessages,
      setLocalMessages,
      messagesScrollRef,
    })

  // Fresh props replace the local message cache wholesale. They carry only the
  // most-recent slice again, so any previously loaded older history is gone —
  // reset the "nothing older" flags so the load-older control reappears.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalMessages(messagesByConversation)
    setNoOlder({})
  }, [messagesByConversation, setNoOlder])

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
    sendVoice,
    scheduleSend,
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

  // Channel types that actually have chats — drives whether the "Тип" filter
  // menu is worth showing at all.
  const availableTypes = (
    ['telegram', 'whatsapp', 'livechat', 'max', 'vk'] as ChannelType[]
  ).filter((t) => typeCounts[t] > 0)

  const activeStatusValue =
    active && active.statusManual
      ? leadStatusOptionValue(active.status, active.statusDetail)
      : 'auto'

  return {
    // selection + drafts
    activeId,
    setActiveId,
    active,
    thread,
    persistDraft,
    getDraft,
    // edit-history dialog + details drawer
    historyMessage,
    setHistoryMessage,
    detailsOpen,
    setDetailsOpen,
    // conversation actions
    conversations,
    statusPending,
    dismissedOverrides,
    isMuted,
    changeStatus,
    dismissReply,
    toggleMute,
    toggleAi,
    // transfer + meeting
    transferForId,
    setTransferForId,
    transferTo,
    setTransferTo,
    transferNote,
    setTransferNote,
    transferPending,
    meetingPending,
    openTransfer,
    submitTransfer,
    startVideoMeeting,
    // AI button pulse
    aiButtonPulse,
    pulseAiButton,
    // muted toggle
    showMuted,
    setShowMuted,
    // filters
    search,
    setSearch,
    typeFilter,
    toggleType,
    sourceFilter,
    toggleSource,
    statusFilter,
    toggleStatus,
    reasonFilter,
    toggleReason,
    sortMode,
    setSortMode,
    hasActiveFilters,
    clearFilters,
    // realtime
    syncState,
    typingByConv,
    presenceByConv,
    // derived
    typeCounts,
    statusCounts,
    reasonCounts,
    sources,
    awaitingReply,
    mutedCount,
    unreadTotal,
    forwardTargets,
    pendingHandoffs,
    filtered,
    // transitions
    pending,
    // active thread derived
    activeAiLed,
    activeTransferred,
    activeTyping,
    activePresence,
    availableTypes,
    activeStatusValue,
    // scroll + history
    messagesScrollRef,
    handleThreadScroll,
    threadLoading,
    loadingOlder,
    noOlder,
    handleLoadOlder,
    // message actions
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
    sendVoice,
    scheduleSend,
    handleSendMediaFile,
  }
}
