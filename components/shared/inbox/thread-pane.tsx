'use client'

import type { ReactNode, RefObject } from 'react'
import { toast } from 'sonner'
import { MessageList } from '@/components/manager/inbox/message-list'
import {
  MessageComposer,
  type MessageComposerProps,
} from '@/components/manager/inbox/message-composer'
import { ComposerBanners } from '@/components/manager/inbox/composer-banners'
import type { ForwardTarget } from '@/components/manager/message-context-menu'
import type { VisitorTyping } from '@/components/manager/inbox/use-inbox-realtime'
import type { Conversation, Message } from '@/lib/types'
import type { useMessageActions } from './use-message-actions'

type MessageActions = ReturnType<typeof useMessageActions>

/** Composer props the pane fills in itself from `actions`/`active`. */
type OwnedComposerProps =
  | 'conversationId'
  | 'channelType'
  | 'channelId'
  | 'getInitialDraft'
  | 'onPersistDraft'
  | 'onSend'
  | 'onSendSticker'
  | 'onSendMediaFile'
  | 'onSendMediaBatch'
  | 'onSendVoice'
  | 'onVoiceError'
  | 'onScheduleSend'
  | 'replyActive'
  | 'editing'
  | 'pending'

export type ThreadPaneComposerProps = Omit<
  MessageComposerProps,
  OwnedComposerProps
> & { onVoiceError?: (message: string) => void }

/**
 * The open-thread column shared by the manager (`/app`) and the curator
 * (`/curator/chats`): loading/empty states → MessageList → an optional slot
 * above the composer (the manager's "лид вернулся на дожим" banner) →
 * reply/edit banners → the composer, or a read-only notice in its place.
 *
 * Both roles hand it the SAME `actions` object (from the shared
 * `useMessageActions`) and the SAME history/scroll props, so the wiring
 * between list, banners and composer exists exactly once. Role-specific
 * composer features (AI toggle, quick replies, Telemost) arrive via
 * `composer`, and are simply omitted by roles that do not have them — the
 * composer's defaults describe a human-led thread.
 *
 * The thread header is NOT part of the pane: each role portals its own into
 * the dashboard shell (they differ a lot — AI toggle, transfer, status vs.
 * curator lead status + info button).
 */
export function ThreadPane({
  active,
  activeId,
  thread,
  threadLoading,
  loadingOlder,
  noOlder,
  onLoadOlder,
  forwardTargets,
  activeTyping = null,
  messagesScrollRef,
  onThreadScroll,
  actions,
  pending,
  onShowHistory,
  highlightedId,
  onBubbleClick,
  hideDeliveryStatus = false,
  emptyLabel = 'Сообщений пока нет.',
  beforeComposer,
  composer,
  composerReplacement,
  getInitialDraft,
  onPersistDraft,
}: {
  active: Conversation
  activeId: string | null
  thread: Message[]
  threadLoading: boolean
  loadingOlder: boolean
  noOlder: Record<string, boolean>
  onLoadOlder: () => void
  forwardTargets: ForwardTarget[]
  activeTyping?: VisitorTyping | null
  messagesScrollRef: RefObject<HTMLDivElement | null>
  onThreadScroll: () => void
  actions: MessageActions
  /** A server action is in flight (disables the composer's send button). */
  pending: boolean
  /** Open the edit-history dialog for a message; roles without it omit. */
  onShowHistory?: (message: Message) => void
  highlightedId?: string | null
  onBubbleClick?: (message: Message) => void
  hideDeliveryStatus?: boolean
  emptyLabel?: string
  /** Rendered between the list and the banners (role-specific notices). */
  beforeComposer?: ReactNode
  /** Role-specific composer options; omit for a plain human-led composer. */
  composer?: ThreadPaneComposerProps
  /** When set, replaces the composer entirely (read-only thread). */
  composerReplacement?: ReactNode
  getInitialDraft: (conversationId: string) => string
  onPersistDraft: (conversationId: string, text: string) => void
}) {
  const {
    replyTarget,
    setReplyTarget,
    editTarget,
    setEditTarget,
    handleReply,
    handleEdit,
    handleSend,
    reactTo,
    deleteMessage,
    forwardMessage,
    copyMessageText,
    sendSticker,
    sendVoice,
    scheduleSend,
    handleSendMediaFile,
    handleSendMediaBatch,
  } = actions

  const { onVoiceError, ...composerRest } = composer ?? {}
  const showEmpty = !threadLoading && thread.length === 0
  const showLoading = threadLoading && thread.length === 0

  return (
    <>
      {showLoading ? (
        <div className="flex flex-1 items-center justify-center bg-muted/20 text-sm text-muted-foreground">
          Загрузка переписки…
        </div>
      ) : showEmpty ? (
        <div className="flex flex-1 items-center justify-center bg-muted/20 text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <MessageList
          active={active}
          activeId={activeId}
          thread={thread}
          threadLoading={threadLoading}
          noOlder={noOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlder}
          forwardTargets={forwardTargets}
          activeTyping={activeTyping}
          messagesScrollRef={messagesScrollRef}
          onThreadScroll={onThreadScroll}
          onReply={handleReply}
          onEdit={handleEdit}
          onReact={reactTo}
          onCopy={copyMessageText}
          onForward={forwardMessage}
          onDelete={deleteMessage}
          onShowHistory={onShowHistory ?? noop}
          highlightedId={highlightedId}
          onBubbleClick={onBubbleClick}
          hideDeliveryStatus={hideDeliveryStatus}
        />
      )}

      {beforeComposer}

      <ComposerBanners
        editTarget={editTarget}
        replyTarget={replyTarget}
        onCancelEdit={() => setEditTarget(null)}
        onCancelReply={() => setReplyTarget(null)}
      />

      {composerReplacement ?? (
        // Keyed by conversation id so each thread gets its own local draft
        // (persisted across switches via the drafts store).
        <MessageComposer
          key={active.id}
          conversationId={active.id}
          channelType={active.channelType}
          channelId={active.channelId}
          getInitialDraft={getInitialDraft}
          onPersistDraft={(text) => onPersistDraft(active.id, text)}
          onSend={handleSend}
          onSendSticker={sendSticker}
          onSendMediaFile={handleSendMediaFile}
          onSendMediaBatch={handleSendMediaBatch}
          onSendVoice={sendVoice}
          onVoiceError={onVoiceError ?? ((m) => toast.error(m))}
          onScheduleSend={scheduleSend}
          pending={pending}
          replyActive={Boolean(replyTarget) || Boolean(editTarget)}
          editing={
            editTarget
              ? { id: editTarget.id, body: editTarget.body ?? '' }
              : null
          }
          {...composerRest}
        />
      )}
    </>
  )
}

function noop() {}
