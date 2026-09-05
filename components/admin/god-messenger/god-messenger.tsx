'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import type { Channel, Manager } from '@/lib/types'
import { NewChatDialog } from './new-chat-dialog'
import { ChatListPane } from './chat-list-pane'
import { ThreadPane, MESSAGES_WINDOW } from './thread-pane'
import { MessageActionSheet } from './message-action-sheet'
import { useGodThread } from './use-god-thread'
import { useGodScroll } from './use-god-scroll'
import { useGodComposer } from './use-god-composer'

/**
 * God messenger root. A phone-first, full-screen chat surface where the god
 * "is" the client: MY messages (direction 'in') sit on the right, the manager's
 * replies (direction 'out') on the left — the mirror image of the manager inbox.
 * Reuses the god-console server actions + the admin SSE stream, so everything is
 * live and lands in the real manager inbox.
 *
 * Telegram-parity features: real quoted replies, edit/delete own messages,
 * emoji palette, file/photo/video attachments, voice notes, optimistic sends,
 * SSE reconnect resync, smart autoscroll and a long-press action sheet.
 *
 * This file is a thin orchestrator: data loading lives in use-god-thread,
 * scroll/swipe in use-god-scroll, composing/sending in use-god-composer, and
 * the two panes + action sheet are presentational components.
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

  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  // Render window: only the newest N messages hit the DOM. Long chats
  // (hundreds of messages) otherwise make opening a thread visibly slow on
  // mobile. "Показать ещё" expands the window; SSE appends work unchanged.
  const [visibleCount, setVisibleCount] = useState(MESSAGES_WINDOW)

  /* Per-thread reset plumbing. useGodThread fires onThreadSwitch whenever the
   * selection changes; the composer/scroll hooks are initialized AFTER the
   * thread hook (they consume its outputs), so their reset functions are wired
   * up through refs that are refreshed on every render. */
  const composerResetRef = useRef<() => void>(() => {})
  const scrollResetRef = useRef<() => void>(() => {})
  const onThreadSwitch = useCallback(() => {
    composerResetRef.current()
    scrollResetRef.current()
    setVisibleCount(MESSAGES_WINDOW)
  }, [])

  // Stable so the memoised ChatListPane doesn't re-render on every draft
  // keystroke (its other props are unchanged while typing).
  const openCreate = useCallback(() => setCreateOpen(true), [])

  const thread = useGodThread({ deepLinkId, search, onThreadSwitch })

  const scroll = useGodScroll({
    selectedId: thread.selectedId,
    messages: thread.messages,
    onSwipeBack: () => thread.selectThread(null),
  })

  const composer = useGodComposer({
    selectedIdRef: thread.selectedIdRef,
    conversation: thread.conversation,
    setMessages: thread.setMessages,
    loadList: thread.loadList,
    pinOnNextGrowth: scroll.pinOnNextGrowth,
  })

  useEffect(() => {
    composerResetRef.current = composer.resetForNewThread
    scrollResetRef.current = scroll.resetForNewThread
  })

  const managerNameOf = useMemo(() => {
    const map = new Map(managers.map((m) => [m.id, m.name]))
    return (id: string | null) => (id ? map.get(id) ?? '—' : '—')
  }, [managers])

  const showThread = thread.selectedId !== null

  const replyLabel = composer.replyTo
    ? composer.replyTo.direction === 'in'
      ? 'Вы'
      : managerNameOf(thread.conversation?.managerId ?? null)
    : ''

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <ChatListPane
          showThread={showThread}
          live={thread.live}
          pushAvailable={pushAvailable}
          search={search}
          onSearchChange={setSearch}
          loadingList={thread.loadingList}
          conversations={thread.conversations}
          selectedId={thread.selectedId}
          onSelect={thread.selectThread}
          onCreate={openCreate}
          managerNameOf={managerNameOf}
        />

        <ThreadPane
          conversation={thread.conversation}
          selectedId={thread.selectedId}
          loadingThread={thread.loadingThread}
          messages={thread.messages}
          visibleCount={visibleCount}
          onShowMore={() => setVisibleCount((c) => c + MESSAGES_WINDOW)}
          managerNameOf={managerNameOf}
          selectThread={thread.selectThread}
          retryLoad={() => {
            if (thread.selectedId) thread.loadThreadRef.current(thread.selectedId)
          }}
          scrollBoxRef={scroll.scrollBoxRef}
          endRef={scroll.endRef}
          onScrollBox={scroll.onScrollBox}
          backDrag={scroll.backDrag}
          onBackPointerDown={scroll.onBackPointerDown}
          onBackPointerMove={scroll.onBackPointerMove}
          onBackPointerEnd={scroll.onBackPointerEnd}
          valueRef={composer.valueRef}
          applyValue={composer.applyValue}
          markDraft={composer.markDraft}
          hasDraft={composer.hasDraft}
          replyTo={composer.replyTo}
          editing={composer.editing}
          replyLabel={replyLabel}
          uploading={composer.uploading}
          pending={composer.pending}
          recording={composer.recording}
          recordSecs={composer.recordSecs}
          composerRef={composer.composerRef}
          fileInputRef={composer.fileInputRef}
          startReply={composer.startReply}
          onMenu={composer.setMenuFor}
          cancelComposeExtras={composer.cancelComposeExtras}
          sendMessage={composer.sendMessage}
          onFilePicked={composer.onFilePicked}
          startRecording={composer.startRecording}
          finishRecording={composer.finishRecording}
        />
      </div>

      {/* --------------- Message action sheet (long-press) --------------- */}
      {composer.menuFor && (
        <MessageActionSheet
          message={composer.menuFor}
          onAction={composer.menuAction}
          onClose={() => composer.setMenuFor(null)}
        />
      )}

      <NewChatDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        channels={channels}
        onCreated={(id) => {
          setCreateOpen(false)
          void thread.loadList({ silent: true })
          // Open the freshly created thread right away (as documented).
          if (id) thread.selectThread(id)
        }}
      />
    </div>
  )
}
