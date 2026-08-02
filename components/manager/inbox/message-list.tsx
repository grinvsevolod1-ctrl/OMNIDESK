'use client'

import type { RefObject } from 'react'
import { ChevronUp, History, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  MessageContextMenu,
  type ForwardTarget,
} from '@/components/manager/message-context-menu'
import {
  isMediaPlaceholder,
  MessageMedia,
} from '@/components/manager/inbox/message-media'
import { CHANNEL_VISUAL, dayLabel, timeShort } from '@/components/manager/inbox/visual'
import { DeliveryTicks } from '@/components/manager/inbox/atoms'
import type { Conversation, Message } from '@/lib/types'
import type { VisitorTyping } from '@/components/manager/inbox/use-inbox-realtime'

/**
 * The scrollable message feed of the open thread: older-history loader, day
 * separators, bubbles (media / reply preview / deleted markers / reactions),
 * the message context menu and the live "visitor is typing" preview.
 * Extracted verbatim from inbox-view.tsx.
 */
export function MessageList({
  active,
  activeId,
  thread,
  noOlder,
  loadingOlder,
  onLoadOlder,
  forwardTargets,
  activeTyping,
  messagesScrollRef,
  onThreadScroll,
  onReply,
  onEdit,
  onReact,
  onCopy,
  onForward,
  onDelete,
  onShowHistory,
}: {
  active: Conversation
  activeId: string | null
  thread: Message[]
  noOlder: Record<string, boolean>
  loadingOlder: boolean
  onLoadOlder: () => void
  forwardTargets: ForwardTarget[]
  activeTyping: VisitorTyping | null
  messagesScrollRef: RefObject<HTMLDivElement | null>
  onThreadScroll: () => void
  onReply: (message: Message) => void
  onEdit: (message: Message) => void
  onReact: (message: Message, emoji: string) => void
  onCopy: (message: Message) => void
  onForward: (message: Message, toConversationId: string) => void
  onDelete: (message: Message) => void
  onShowHistory: (message: Message) => void
}) {
  return (
    <div
      ref={messagesScrollRef}
      onScroll={onThreadScroll}
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
              onClick={onLoadOlder}
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
                    m.mediaType && (m.mediaUrl || m.mediaType === 'sticker'),
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
                              onClick={() => onShowHistory(m)}
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
                          onReply={onReply}
                          onReact={onReact}
                          onCopy={onCopy}
                          onForward={onForward}
                          onEdit={isOut ? onEdit : undefined}
                          onDelete={onDelete}
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
                                canAct && onReact(m, r.fromMe ? '' : r.emoji)
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
      </div>
    </div>
  )
}
