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
import { acknowledgeAiHandoffAction } from '@/app/actions/messages'
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
import { leadStatusOptionValue } from '@/lib/types'
import type {
  ChannelType,
  Conversation,
  Message,
  QuickReply,
} from '@/lib/types'
import { useInboxFilters } from '@/components/manager/inbox/use-inbox-filters'
import { useDrafts } from '@/components/manager/inbox/use-drafts'
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
import { useReplyReminder } from '@/components/manager/inbox/use-reply-reminder'
import { useThreadHistory } from '@/components/manager/inbox/use-thread-history'
import { useThreadScroll } from '@/components/manager/inbox/use-thread-scroll'
import { useMessageActions } from '@/components/manager/inbox/use-message-actions'
import { useConversationActions } from '@/components/manager/inbox/use-conversation-actions'
import { useTransferMeeting } from '@/components/manager/inbox/use-transfer-meeting'
import { useInboxDerived } from '@/components/manager/inbox/use-inbox-derived'

/* -------------------------------------------------------------------------- */
/*  Main component — orchestrator only. The heavy lifting lives in hooks:     */
/*  useConversationActions (optimistic overrides + status/mute/AI actions),   */
/*  useInboxDerived (counters/awaiting-reply/sources), useTransferMeeting     */
/*  (hand-off dialog + Telemost), useMessageActions (send/edit/react/...).    */
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
              onSendVoice={sendVoice}
              onVoiceError={(message) => toast.error(message)}
              onScheduleSend={scheduleSend}
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
