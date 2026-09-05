'use client'

import dynamic from 'next/dynamic'
import { MessageCircle } from 'lucide-react'
import { toast } from 'sonner'
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
import type { Conversation, Message, QuickReply } from '@/lib/types'
import { DetailsPanel } from '@/components/manager/inbox/atoms'
import { MessageComposer } from '@/components/manager/inbox/message-composer'
import { TransferDialog } from '@/components/manager/inbox/transfer-dialog'
import { ConversationList } from '@/components/manager/inbox/conversation-list'
import { AiHandoffBanner } from '@/components/manager/inbox/ai-handoff-banner'
import { ThreadHeader } from '@/components/manager/inbox/thread-header'
import { MessageList } from '@/components/manager/inbox/message-list'
import { ComposerBanners } from '@/components/manager/inbox/composer-banners'
import { useInbox } from '@/components/manager/inbox/use-inbox'
import { useInboxShortcuts } from '@/components/manager/inbox/use-inbox-shortcuts'
import { useThreadSearch } from '@/components/manager/inbox/thread-search'
import { useCallback, useEffect, useState } from 'react'

/* -------------------------------------------------------------------------- */
/*  Presentational shell. All state/effects/actions live in useInbox; this    */
/*  component only wires the returned bag into the list / thread / drawer.     */
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
  const inbox = useInbox({
    conversations: rawConversations,
    messagesByConversation,
    currentUser,
    aiMasterEnabled,
    ownedChannelIds,
  })

  const {
    activeId,
    setActiveId,
    active,
    thread,
    persistDraft,
    getDraft,
    historyMessage,
    setHistoryMessage,
    detailsOpen,
    setDetailsOpen,
    conversations,
    statusPending,
    dismissedOverrides,
    isMuted,
    changeStatus,
    dismissReply,
    toggleMute,
    toggleAi,
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
    aiButtonPulse,
    pulseAiButton,
    showMuted,
    setShowMuted,
    viewBucket,
    setViewBucket,
    transferredCount,
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
    syncState,
    typingByConv,
    presenceByConv,
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
    pending,
    activeAiLed,
    activeTransferred,
    activeTyping,
    activePresence,
    availableTypes,
    activeStatusValue,
    messagesScrollRef,
    handleThreadScroll,
    threadLoading,
    loadingOlder,
    noOlder,
    handleLoadOlder,
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
  } = inbox

  // j/k and Alt+arrows walk the filtered list without touching the mouse.
  useInboxShortcuts({ filtered, activeId, setActiveId })

  /**
   * Скролл к сообщению по id для поиска/медиа-навигации. true — сообщение
   * уже в DOM (проскроллили), false — надо догружать историю.
   */
  const scrollToMessage = useCallback(
    (id: string): boolean => {
      const container = messagesScrollRef.current
      if (!container) return false
      const el = container.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
      if (!el) return false
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return true
    },
    [messagesScrollRef],
  )

  // Телеграм-стиль поиск по диалогу + навигация по кружкам/фото
  // с прикреплением к карточке лида.
  // Открытая карточка лида (fixed-панель 28rem справа): тред получает правый
  // отступ, чтобы карточка НЕ перекрывала контент диалога; при закрытии
  // отступ снимается и раскладка возвращается в исходное состояние.
  const [leadCardOpen, setLeadCardOpen] = useState(false)
  useEffect(() => {
    const onCardOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ open?: boolean }>).detail
      setLeadCardOpen(Boolean(detail?.open))
    }
    window.addEventListener('omnidesk:lead-card-open', onCardOpen)
    return () =>
      window.removeEventListener('omnidesk:lead-card-open', onCardOpen)
  }, [])

  const threadSearch = useThreadSearch({
    conversationId: activeId,
    loadOlder: handleLoadOlder,
    scrollToMessage,
    onAttached: (leadCardId) => {
      // Сообщаем карточке лида (LeadCardPanel), что вложения изменились.
      window.dispatchEvent(
        new CustomEvent('omnidesk:lead-attachments-changed', {
          detail: { leadCardId },
        }),
      )
    },
  })

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
        hiddenForFocus={threadSearch.mediaActive}
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
        transferredCount={transferredCount}
        viewBucket={viewBucket}
        setViewBucket={setViewBucket}
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
          // Открытая карточка лида / медиа-режим: карточка (fixed, 28rem
          // справа) не должна перекрывать контент — тред получает правый
          // отступ, диалог и бар навигации видны целиком рядом с карточкой.
          // Плавный переход синхронизирован со слайдом самой панели.
          'transition-[padding] duration-300 ease-out',
          (leadCardOpen || threadSearch.mediaActive) &&
            'sm:pr-[min(28rem,45vw)]',
        )}
      >
        {active ? (
          <>
            <ThreadHeader
              active={active}
              activePresence={activePresence}
              activeAiLed={activeAiLed}
              transferred={activeTransferred}
              curatorName={active.curatorName}
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
              onOpenSearch={threadSearch.openText}
              onBrowseMedia={threadSearch.openMedia}
            />

            {/* Бар поиска/медиа-навигации — под шапкой, над сообщениями. */}
            {threadSearch.bar}

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
              highlightedId={threadSearch.highlightedId}
              onBubbleClick={
                threadSearch.attachLeadCardId
                  ? threadSearch.onMessageClick
                  : undefined
              }
            />

            <ComposerBanners
              editTarget={editTarget}
              replyTarget={replyTarget}
              onCancelEdit={() => setEditTarget(null)}
              onCancelReply={() => setReplyTarget(null)}
            />

            {/* Лид передан куратору (миграция 151): менеджер только читает —
                композер заменяется баннером, чтобы не было двух отвечающих. */}
            {activeTransferred ? (
              <div className="border-t border-border bg-muted/40 px-4 py-3 text-center text-sm text-muted-foreground">
                Лид передан куратору
                {active.curatorName ? ` ${active.curatorName}` : ''}. Переписку
                ведёт куратор — вам доступно только чтение.
              </div>
            ) : (
            /* Composer — isolated component so typing never re-renders the
                whole inbox. Keyed by conversation id so each thread gets its own
                local draft (persisted across switches via draftsRef). */
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
            )}
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
