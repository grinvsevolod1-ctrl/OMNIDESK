'use client'

/**
 * Right pane of the god messenger: skeleton/empty states, thread header,
 * message feed with "show more" windowing, and the composer (text, file,
 * voice recording, reply/edit banner).
 *
 * Purely presentational: ALL state lives in the god-messenger hooks
 * (use-god-thread / use-god-scroll / use-god-composer) and is passed down as
 * props, so this file never re-renders the list pane and vice versa.
 */

import type React from 'react'
import { useEffect, useRef } from 'react'
import {
  Check,
  ChevronLeft,
  CornerUpLeft,
  Loader2,
  MessagesSquare,
  Mic,
  Paperclip,
  Pencil,
  Send,
  Trash2,
  X,
} from 'lucide-react'

import type { ConversationWithManager } from '@/app/actions/admin-secret'
import { ContactAvatar, SourceChip } from '@/components/manager/inbox/atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Message } from '@/lib/types'
import { isComposing } from './utils'
import { MessageBubble } from './message-bubble'
import { snippetOf } from './reply'
import { EmojiPicker } from './emoji-picker'

/* Conversation shape used by the god panel (full row from use-god-thread —
 * gives the header access to channelId/channelName for the source chip). */
export type GodConversation = ConversationWithManager

/* How many newest messages are rendered initially / added per "show more". */
export const MESSAGES_WINDOW = 50

interface ThreadPaneProps {
  conversation: GodConversation | null
  selectedId: string | null
  loadingThread: boolean
  messages: Message[]
  visibleCount: number
  onShowMore: () => void
  managerNameOf: (id: string | null) => string
  selectThread: (id: string | null) => void
  retryLoad: () => void
  /* Scroll plumbing (use-god-scroll) */
  scrollBoxRef: React.RefObject<HTMLDivElement | null>
  endRef: React.RefObject<HTMLDivElement | null>
  onScrollBox: () => void
  backDrag: number
  onBackPointerDown: (e: React.PointerEvent) => void
  onBackPointerMove: (e: React.PointerEvent) => void
  onBackPointerEnd: (e: React.PointerEvent) => void
  /* Composer plumbing (use-god-composer) */
  valueRef: React.MutableRefObject<string>
  applyValue: (next: string, focusEnd?: boolean) => void
  markDraft: (next: string) => void
  hasDraft: boolean
  replyTo: Message | null
  editing: Message | null
  replyLabel: string
  uploading: boolean
  pending: boolean
  recording: boolean
  recordSecs: number
  composerRef: React.RefObject<HTMLTextAreaElement | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  startReply: (m: Message) => void
  onMenu: (m: Message) => void
  cancelComposeExtras: () => void
  sendMessage: () => void
  onFilePicked: (e: React.ChangeEvent<HTMLInputElement>) => void
  startRecording: () => void
  finishRecording: (cancel: boolean) => void
}

export function ThreadPane({
  conversation,
  selectedId,
  loadingThread,
  messages,
  visibleCount,
  onShowMore,
  managerNameOf,
  selectThread,
  retryLoad,
  scrollBoxRef,
  endRef,
  onScrollBox,
  backDrag,
  onBackPointerDown,
  onBackPointerMove,
  onBackPointerEnd,
  valueRef,
  applyValue,
  markDraft,
  hasDraft,
  replyTo,
  editing,
  replyLabel,
  uploading,
  pending,
  recording,
  recordSecs,
  composerRef,
  fileInputRef,
  startReply,
  onMenu,
  cancelComposeExtras,
  sendMessage,
  onFilePicked,
  startRecording,
  finishRecording,
}: ThreadPaneProps) {
  const showThread = selectedId !== null

  // Auto-grow the textarea (Telegram-style), capped at 160px. The textarea is
  // uncontrolled (owned by `use-god-composer`), so programmatic value changes
  // resize inside `applyValue`; only the typing hot path resizes here. Measuring
  // the textarea forces a synchronous reflow, so we coalesce it into a single
  // rAF per frame — the typed character paints first, then the box grows.
  const resizeRaf = useRef<number | null>(null)
  const scheduleResize = () => {
    if (resizeRaf.current != null) return
    resizeRaf.current = requestAnimationFrame(() => {
      resizeRaf.current = null
      const el = composerRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    })
  }
  useEffect(
    () => () => {
      if (resizeRaf.current != null) cancelAnimationFrame(resizeRaf.current)
    },
    [],
  )

  return (
    <section
      className={cn(
        'relative min-w-0 flex-1 flex-col',
        showThread ? 'flex' : 'hidden md:flex',
      )}
      style={{
        transform: backDrag ? `translateX(${backDrag}px)` : undefined,
        transition: backDrag ? 'none' : 'transform 0.2s ease-out',
        willChange: backDrag ? 'transform' : undefined,
        touchAction: 'pan-y',
      }}
      onPointerDown={conversation ? onBackPointerDown : undefined}
      onPointerMove={conversation ? onBackPointerMove : undefined}
      onPointerUp={conversation ? onBackPointerEnd : undefined}
      onPointerCancel={conversation ? onBackPointerEnd : undefined}
    >
      {!conversation && selectedId ? (
        <div className="flex flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-border px-2 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] sm:px-3">
            <button
              type="button"
              onClick={() => selectThread(null)}
              className="flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
              aria-label="Назад к списку"
            >
              <ChevronLeft className="size-6" />
            </button>
            <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3.5 w-32 animate-pulse rounded bg-muted" />
              <div className="h-3 w-44 animate-pulse rounded bg-muted/70" />
            </div>
          </header>
          <div className="flex flex-1 items-center justify-center bg-muted/20">
            {loadingThread ? (
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            ) : (
              <div className="flex flex-col items-center gap-3 text-center">
                <p className="text-sm text-muted-foreground">
                  Не удалось загрузить переписку
                </p>
                <button
                  type="button"
                  onClick={retryLoad}
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  Повторить
                </button>
              </div>
            )}
          </div>
        </div>
      ) : !conversation ? (
        <div className="hidden flex-1 items-center justify-center p-6 md:flex">
          <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
            <MessagesSquare className="size-12 opacity-40" />
            <p className="text-sm">Выберите диалог слева</p>
          </div>
        </div>
      ) : (
        <>
          <header className="flex items-center gap-2 border-b border-border px-2 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] backdrop-blur sm:px-3">
            <button
              type="button"
              onClick={() => selectThread(null)}
              className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
              aria-label="Назад к списку"
            >
              <ChevronLeft className="size-6" />
            </button>
            <ContactAvatar
              name={conversation.contactName || conversation.contactHandle}
              channel={conversation.channelType}
              channelId={conversation.channelId}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight">
                {conversation.contactName || conversation.contactHandle}
              </p>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                <SourceChip conversation={conversation} size="xs" />
                <span className="truncate text-xs text-muted-foreground">
                  Менеджер: {managerNameOf(conversation.managerId)}
                </span>
              </div>
            </div>
          </header>

          <div
            ref={scrollBoxRef}
            onScroll={onScrollBox}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-muted/20 px-2 py-4 sm:px-3"
          >
            <div className="space-y-1.5">
              {loadingThread ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : messages.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  Сообщений пока нет. Напишите первое.
                </p>
              ) : (
                <>
                  {messages.length > visibleCount && (
                    <button
                      type="button"
                      onClick={onShowMore}
                      className="mx-auto mb-2 block rounded-full border border-border bg-background px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      Показать ещё ({messages.length - visibleCount} скрыто)
                    </button>
                  )}
                  {messages.slice(-visibleCount).map((m, i, visible) => (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      prev={visible[i - 1]}
                      next={visible[i + 1]}
                      isLast={i === visible.length - 1}
                      onReply={startReply}
                      onMenu={onMenu}
                    />
                  ))}
                </>
              )}
              <div ref={endRef} />
            </div>
          </div>

          <div
            className="border-t border-border bg-background px-2 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2 sm:px-3"
            data-no-swipe
          >
            {(replyTo || editing) && (
              <div className="mb-2 flex items-center gap-2 rounded-xl border-l-2 border-primary bg-muted/60 py-2 pl-3 pr-2">
                {editing ? (
                  <Pencil className="size-4 shrink-0 text-primary" />
                ) : (
                  <CornerUpLeft className="size-4 shrink-0 text-primary" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-primary">
                    {editing ? 'Редактирование' : replyLabel}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {editing
                      ? snippetOf(editing) || 'Сообщение'
                      : replyTo
                        ? snippetOf(replyTo) || 'Сообщение'
                        : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={cancelComposeExtras}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={editing ? 'Отменить редактирование' : 'Отменить ответ'}
                >
                  <X className="size-4" />
                </button>
              </div>
            )}

            {recording ? (
              <div className="flex items-center gap-3 rounded-3xl border border-input bg-card px-4 py-2.5">
                <span className="flex items-center gap-2 text-sm text-destructive">
                  <span className="size-2.5 animate-pulse rounded-full bg-destructive" />
                  Запись…{' '}
                  <span className="tabular-nums">
                    {String(Math.floor(recordSecs / 60)).padStart(1, '0')}:
                    {String(recordSecs % 60).padStart(2, '0')}
                  </span>
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-10 rounded-full"
                    onClick={() => finishRecording(true)}
                    aria-label="Отменить запись"
                  >
                    <Trash2 className="size-5" />
                  </Button>
                  <Button
                    size="icon"
                    className="size-11 rounded-full"
                    onClick={() => finishRecording(false)}
                    aria-label="Отправить голосовое"
                  >
                    <Send className="size-5" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-end gap-1.5">
                {/* Единая «пилюля» (Telegram-style): эмодзи, расширяющееся поле
                    и скрепка внутри одного скруглённого контейнера, который
                    подсвечивается при фокусе и растёт вместе с текстом. */}
                <div className="flex flex-1 items-end gap-0.5 rounded-3xl bg-muted px-1.5 py-1 transition-all focus-within:bg-card focus-within:ring-[3px] focus-within:ring-ring/30">
                  <EmojiPicker
                    onPick={(emoji) => applyValue(valueRef.current + emoji, true)}
                  />
                  <textarea
                    ref={composerRef}
                    defaultValue={valueRef.current}
                    onChange={(e) => {
                      // Mirrors the DOM value into valueRef and flips hasDraft only
                      // on empty↔non-empty transitions, so ordinary keystrokes cause
                      // NO re-render of the messenger (the lag fix).
                      markDraft(e.target.value)
                      scheduleResize()
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
                        e.preventDefault()
                        sendMessage()
                      }
                      if (e.key === 'Escape' && (editing || replyTo)) {
                        cancelComposeExtras()
                      }
                    }}
                    rows={1}
                    placeholder={
                      editing
                        ? 'Новый текст сообщения…'
                        : 'Сообщение от имени клиента…'
                    }
                    className="scrollbar-thin max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={onFilePicked}
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                  {!editing && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50"
                      aria-label="Прикрепить файл"
                    >
                      {uploading ? (
                        <Loader2 className="size-5 animate-spin" />
                      ) : (
                        <Paperclip className="size-5" />
                      )}
                    </button>
                  )}
                </div>

                {/* Свап Микрофон ⇄ Отправка: пустое поле показывает микрофон
                    (голосовое), любой введённый текст превращает кнопку в
                    «отправить»; режим редактирования всегда показывает галочку. */}
                {hasDraft || editing ? (
                  <Button
                    size="icon"
                    className="size-10 shrink-0 rounded-full transition-transform duration-150 animate-in fade-in-0 zoom-in-95 active:scale-90"
                    onClick={sendMessage}
                    disabled={pending || (!hasDraft && !editing)}
                    aria-label={editing ? 'Сохранить' : 'Отправить'}
                  >
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : editing ? (
                      <Check className="size-4" />
                    ) : (
                      <Send className="size-4" />
                    )}
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    variant="secondary"
                    className="size-10 shrink-0 rounded-full animate-in fade-in-0 zoom-in-95"
                    onClick={startRecording}
                    disabled={uploading}
                    aria-label="Записать голосовое сообщение"
                  >
                    <Mic className="size-5" />
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
