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

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Message } from '@/lib/types'
import { TYPE_LABEL, initials, isComposing } from './utils'
import { MessageBubble } from './message-bubble'
import { snippetOf } from './reply'
import { EmojiPicker } from './emoji-picker'

/* Conversation shape used by the god panel (see use-god-thread). */
export interface GodConversation {
  id: string
  contactName: string | null
  contactHandle: string
  channelType: string
  managerId: string | null
}

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
  draft: string
  setDraft: React.Dispatch<React.SetStateAction<string>>
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
  draft,
  setDraft,
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
          <header className="flex items-center gap-2 border-b border-border bg-card/40 px-2 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] sm:px-3">
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
          <header className="flex items-center gap-2 border-b border-border bg-card/40 px-2 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] backdrop-blur sm:px-3">
            <button
              type="button"
              onClick={() => selectThread(null)}
              className="flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
              aria-label="Назад к списку"
            >
              <ChevronLeft className="size-6" />
            </button>
            <Avatar className="size-10 shrink-0">
              <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                {initials(conversation.contactName || conversation.contactHandle)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight">
                {conversation.contactName || conversation.contactHandle}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {TYPE_LABEL[conversation.channelType] ?? conversation.channelType} ·
                Менеджер: {managerNameOf(conversation.managerId)}
              </p>
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
                <EmojiPicker
                  onPick={(emoji) => {
                    setDraft((d) => d + emoji)
                    composerRef.current?.focus()
                  }}
                />
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
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
                  className="max-h-40 min-h-[52px] flex-1 resize-none rounded-3xl border border-input bg-card px-4 py-3.5 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
                    className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    aria-label="Прикрепить файл"
                  >
                    {uploading ? (
                      <Loader2 className="size-5 animate-spin" />
                    ) : (
                      <Paperclip className="size-5" />
                    )}
                  </button>
                )}
                {draft.trim() || editing ? (
                  <Button
                    size="icon"
                    className="size-12 shrink-0 rounded-full"
                    onClick={sendMessage}
                    disabled={pending || !draft.trim()}
                    aria-label={editing ? 'Сохранить' : 'Отправить'}
                  >
                    {pending ? (
                      <Loader2 className="size-5 animate-spin" />
                    ) : editing ? (
                      <Check className="size-5" />
                    ) : (
                      <Send className="size-5" />
                    )}
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    variant="secondary"
                    className="size-12 shrink-0 rounded-full"
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
