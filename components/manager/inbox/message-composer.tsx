'use client'

/**
 * The reply composer, extracted from inbox-view.tsx into its own memoised
 * module. Isolated so typing only re-renders this small subtree — not the whole
 * InboxView (list + thread + details) — which previously lagged on every
 * keystroke. Draft text lives in LOCAL state; per-conversation persistence is
 * handled by the parent keying this component on `conversationId`.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  ChevronDown,
  Loader2,
  Paperclip,
  SendHorizonal,
  BrainCircuit,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmojiPicker, StickerPicker } from '@/components/manager/inbox/pickers'
import { VoiceRecorder } from '@/components/manager/inbox/voice-recorder'
import { ScheduleSendPopover } from '@/components/manager/inbox/schedule-send'
import { TelemostIcon } from '@/components/channel-icons'
import { cn } from '@/lib/utils'
import type { ChannelType, QuickReply, StickerItem } from '@/lib/types'

export interface MessageComposerProps {
  conversationId: string
  channelType: ChannelType
  channelId: string
  /** Reads the saved draft for a conversation (called once, in the lazy state
   *  initialiser — a getter avoids reading the parent's ref during render). */
  getInitialDraft: (conversationId: string) => string
  /** Persist the unsent draft back to the parent (called on blur/unmount only,
   *  never per keystroke — that is the whole point of this isolation). */
  onPersistDraft: (text: string) => void
  onSend: (text: string) => void
  onSendSticker: (sticker: StickerItem) => void
  onSendMediaFile: (file: File, caption: string) => void
  /** Send a recorded voice note (Telegram only). */
  onSendVoice: (audio: {
    base64: string
    mime: string
    durationSec: number
  }) => void
  /** Surface a recorder error (mic denied, unsupported browser) to the user. */
  onVoiceError: (message: string) => void
  /** Schedule the drafted text for later delivery (Telegram only). */
  onScheduleSend: (text: string, scheduleAtIso: string) => void
  aiLed: boolean
  /** Fired when the manager tries to type/send while the AI leads the thread. */
  onBlockedInteract: () => void
  onToggleAi: () => void
  statusPending: boolean
  pending: boolean
  quickReplies: QuickReply[]
  telemostEnabled: boolean
  onStartMeeting: () => void
  meetingPending: boolean
  replyActive: boolean
  /** When set, the composer is editing an existing message: the input is
   *  prefilled with its body and submit calls onSend with the new text (the
   *  parent routes it to the edit action). The unsent draft is stashed and
   *  restored when editing ends. */
  editing?: { id: string; body: string } | null
}

/**
 * The reply composer, extracted into its own memoised component so that typing
 * only re-renders this small subtree — not the entire InboxView (conversation
 * list + message thread + details panel), which previously caused visible lag
 * on every keystroke because the draft lived in the parent's state.
 *
 * The text lives in LOCAL state here. Per-conversation draft persistence (so an
 * unsent message survives switching threads, Telegram-style) is handled by the
 * parent keying this component on `conversationId`: React remounts it per
 * thread, we seed from `initialDraft` on mount and write back via
 * `onPersistDraft` on unmount — none of which touches the parent on keystroke.
 */
export const MessageComposer = memo(function MessageComposer({
  conversationId,
  channelType,
  channelId,
  getInitialDraft,
  onPersistDraft,
  onSend,
  onSendSticker,
  onSendMediaFile,
  onSendVoice,
  onVoiceError,
  onScheduleSend,
  aiLed,
  onBlockedInteract,
  onToggleAi,
  statusPending,
  pending,
  quickReplies,
  telemostEnabled,
  onStartMeeting,
  meetingPending,
  replyActive,
  editing = null,
}: MessageComposerProps) {
  const [text, setText] = useState(() => getInitialDraft(conversationId))
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false)
  // "Send later" popover (Telegram): opened by long-pressing the send button,
  // anchored to it — there is no separate clock button anymore.
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const sendBtnRef = useRef<HTMLButtonElement | null>(null)
  // Long-press bookkeeping for the send button. `fired` guards the click that
  // follows a long-press so it does not also submit the message.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFired = useRef(false)

  // Mirror the latest text + persist callback in refs so the unmount cleanup can
  // save the current value without listing `text` in its deps. The refs are
  // updated in effects (never during render) to satisfy the refs lint rule.
  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  }, [text])
  const persistRef = useRef(onPersistDraft)
  useEffect(() => {
    persistRef.current = onPersistDraft
  }, [onPersistDraft])
  useEffect(() => {
    // On unmount (i.e. switching to another conversation) save the unsent
    // draft. If the manager was mid-edit, the input holds the EDIT text — save
    // the stashed real draft instead so the edit never leaks into drafts.
    return () =>
      persistRef.current(
        editingRef.current ? (stashedDraftRef.current ?? '') : textRef.current,
      )
  }, [])
  // Mirror `editing` in a ref so the persistence paths below can check it
  // without adding it to their deps.
  const editingRef = useRef(editing)
  useEffect(() => {
    editingRef.current = editing
  }, [editing])

  // ALSO persist while typing (debounced). Unmount-only persistence loses the
  // draft whenever the tree never unmounts cleanly — a hard reload, a crash,
  // navigating via browser chrome — which managers reported as vanished text.
  // 400ms of idle keeps this far from the per-keystroke hot path. Suspended
  // while editing an existing message: the edit text must never overwrite the
  // unsent draft.
  useEffect(() => {
    if (editing) return
    const t = setTimeout(() => persistRef.current(text), 400)
    return () => clearTimeout(t)
  }, [text, editing])

  const resizeComposer = useCallback(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  // Coalesced, off-critical-path resize for the typing hot path. Measuring the
  // textarea (height:auto → read scrollHeight) forces a synchronous reflow of
  // the whole inbox; doing it inside onChange blocked the typed character from
  // painting, so text lagged. Scheduling it in rAF lets the character paint
  // first and collapses bursts of keystrokes into a single resize per frame.
  const resizeRaf = useRef<number | null>(null)
  const scheduleResize = useCallback(() => {
    if (resizeRaf.current != null) return
    resizeRaf.current = requestAnimationFrame(() => {
      resizeRaf.current = null
      resizeComposer()
    })
  }, [resizeComposer])
  useEffect(
    () => () => {
      if (resizeRaf.current != null) cancelAnimationFrame(resizeRaf.current)
    },
    [],
  )

  // Вставка готового текста извне (например, контакт куратора после передачи
  // лида — см. use-lead-card). Событие адресное: чужие диалоги игнорируют.
  // Текст ЗАМЕНЯЕТ черновик (сценарий один: отправить контакт кандидату),
  // фокус — в поле, курсор в конец, чтобы менеджер сразу нажал «Отправить».
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (
        e as CustomEvent<{ conversationId?: string; text?: string }>
      ).detail
      if (!detail?.text || detail.conversationId !== conversationId) return
      if (editingRef.current) return // не затираем режим редактирования
      setText(detail.text)
      requestAnimationFrame(() => {
        const el = composerRef.current
        if (el) {
          el.focus()
          const end = el.value.length
          el.setSelectionRange(end, end)
        }
        resizeComposer()
      })
    }
    window.addEventListener('omnidesk:composer-insert', onInsert)
    return () =>
      window.removeEventListener('omnidesk:composer-insert', onInsert)
  }, [conversationId, resizeComposer])

  // Entering edit mode: stash the current unsent draft and prefill the input
  // with the message being edited. Leaving edit mode (submit or cancel):
  // restore the stashed draft, Telegram-style.
  const stashedDraftRef = useRef<string | null>(null)
  const editingId = editing?.id ?? null
  const editingBody = editing?.body ?? ''
  useEffect(() => {
    if (editingId) {
      if (stashedDraftRef.current === null) {
        stashedDraftRef.current = textRef.current
      }
      setText(editingBody)
      requestAnimationFrame(() => {
        const el = composerRef.current
        if (el) {
          el.focus()
          const end = el.value.length
          el.setSelectionRange(end, end)
        }
        resizeComposer()
      })
    } else if (stashedDraftRef.current !== null) {
      setText(stashedDraftRef.current)
      stashedDraftRef.current = null
      requestAnimationFrame(resizeComposer)
    }
    // editingBody intentionally read only when editingId changes: retargeting
    // to another message updates it, re-renders of the same edit do not reset
    // the manager's in-progress changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, resizeComposer])

  const submit = useCallback(() => {
    if (aiLed) {
      onBlockedInteract()
      return
    }
    const body = text.trim()
    if (!body) return
    onSend(body)
    setText('')
    // Clear the persisted draft immediately — otherwise the debounced persist
    // (or a stale localStorage entry) could resurrect an already-sent message.
    // Skipped while editing: submitting an edit must not wipe the stashed
    // unsent draft (it is restored by the edit effect right after).
    if (!editingRef.current) persistRef.current('')
    requestAnimationFrame(resizeComposer)
  }, [aiLed, text, onSend, onBlockedInteract, resizeComposer])

  function insertQuickReply(value: string) {
    setText((prev) => {
      const base = prev.trimEnd()
      return base ? `${base} ${value}` : value
    })
    requestAnimationFrame(() => {
      const el = composerRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
      resizeComposer()
    })
  }

  // Telegram-style send/mic swap: an empty field shows the mic (voice note),
  // any drafted text turns the button into "send". Scheduling is only offered
  // for Telegram and never while editing an existing message.
  const hasText = Boolean(text.trim())
  const isTelegram = channelType === 'telegram'
  const canSchedule = isTelegram && !editing
  const showMic = isTelegram && !hasText && !aiLed && !editing

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  // Hold the send button (~380ms) to open the "send later" popover. A short tap
  // sends normally; the long-press flag suppresses the click that follows.
  const startLongPress = useCallback(() => {
    if (!canSchedule || !hasText || pending || aiLed) return
    longPressFired.current = false
    clearLongPress()
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true
      try {
        navigator.vibrate?.(10)
      } catch {
        /* haptics unsupported — silent */
      }
      setScheduleOpen(true)
    }, 380)
  }, [canSchedule, hasText, pending, aiLed, clearLongPress])

  // Never leave a pending long-press timer behind on unmount.
  useEffect(() => clearLongPress, [clearLongPress])

  return (
    <div className={cn('bg-card', replyActive ? '' : 'border-t border-border')}>
      {/* Quick replies tray — manager's saved canned answers, one tap to
          insert into the draft. Collapsed by default to keep the composer
          uncluttered. */}
      {quickReplies.length > 0 ? (
        <div className="border-b border-border/60 px-3 pt-2">
          <button
            type="button"
            onClick={() => setQuickRepliesOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={quickRepliesOpen}
          >
            <Zap className="size-3.5" />
            Автоответы
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
              {quickReplies.length}
            </span>
            <ChevronDown
              className={cn(
                'size-3.5 transition-transform',
                quickRepliesOpen && 'rotate-180',
              )}
            />
          </button>
          {quickRepliesOpen ? (
            <div className="scrollbar-thin -mx-1 mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto px-1 pb-2">
              {quickReplies.map((qr) => (
                <button
                  key={qr.id}
                  type="button"
                  onClick={() => insertQuickReply(qr.body)}
                  title={qr.body}
                  className="max-w-[15rem] truncate rounded-full border border-border bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
                >
                  {qr.title?.trim() || qr.body}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {aiLed ? (
        <button
          type="button"
          onClick={onToggleAi}
          disabled={statusPending}
          className="flex w-full items-center gap-2 border-b border-primary/20 bg-primary/10 px-4 py-2 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/15"
        >
          <BrainCircuit className="size-3.5 shrink-0" />
          <span className="flex-1">
            ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.
          </span>
          <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
            Отключить ИИ
          </span>
        </button>
      ) : null}

      <form
        className="flex items-end gap-1.5 p-2 sm:p-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {/* Единая «пилюля» (Telegram-style): эмодзи, расширяющееся поле и
            кнопки канала (стикеры/скрепка/Телемост) внутри одного скруглённого
            контейнера, который подсвечивается при фокусе и растёт вместе с
            текстом. */}
        <div
          className={cn(
            'flex flex-1 items-end gap-0.5 rounded-3xl bg-muted px-1.5 py-1 transition-all focus-within:bg-card focus-within:ring-[3px] focus-within:ring-ring/30',
            aiLed && 'opacity-60',
          )}
        >
          <EmojiPicker
            onPick={(emoji) => {
              setText((d) => d + emoji)
              requestAnimationFrame(resizeComposer)
            }}
          />
          <textarea
            ref={composerRef}
            value={text}
            rows={1}
            onChange={(e) => {
              setText(e.target.value)
              scheduleResize()
            }}
            onKeyDown={(e) => {
              // Don't submit mid-IME-composition (CJK): Enter confirms the
              // candidate, and Safari reports keyCode 229 for that.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              // Enter sends, Shift+Enter inserts a newline (messenger UX).
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            onMouseDown={(e) => {
              // While the AI leads the thread the composer is locked — vibrate
              // the AI button to point the manager at the fix.
              if (aiLed) {
                e.preventDefault()
                onBlockedInteract()
              }
            }}
            readOnly={aiLed}
            placeholder={
              aiLed
                ? 'ИИ отвечает за вас. Отключите ИИ, чтобы писать.'
                : 'Написать сообщение…'
            }
            aria-label="Текст ответа"
            className={cn(
              'scrollbar-thin max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground',
              aiLed && 'cursor-not-allowed',
            )}
          />
          {isTelegram ? (
            <StickerPicker channelId={channelId} onSend={onSendSticker} />
          ) : null}
          {channelType === 'whatsapp' || channelType === 'vk' ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) {
                    onSendMediaFile(f, text.trim())
                    setText('')
                    persistRef.current('')
                  }
                  e.target.value = ''
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                disabled={pending}
                onClick={() => fileInputRef.current?.click()}
                aria-label="Прикрепить файл"
                title="Прикрепить файл (фото, видео, документ)"
              >
                <Paperclip className="size-5" />
              </Button>
            </>
          ) : null}
          {telemostEnabled ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              disabled={pending || meetingPending}
              onClick={onStartMeeting}
              aria-label="Создать видеовстречу"
              title="Создать видеовстречу в Яндекс Телемост и отправить ссылку клиенту"
            >
              {meetingPending ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <TelemostIcon className="size-5" />
              )}
            </Button>
          ) : null}
        </div>

        {/* Свап Микрофон ⇄ Отправка. Пустое поле у Telegram показывает
            микрофон (голосовое); как только появляется текст — кнопка
            превращается в «отправить». Удержание кнопки открывает «отложку». */}
        {showMic ? (
          <VoiceRecorder
            disabled={pending || aiLed}
            onSend={onSendVoice}
            onError={onVoiceError}
          />
        ) : (
          <Button
            ref={sendBtnRef}
            type="button"
            size="icon"
            className="size-10 shrink-0 rounded-full transition-transform duration-150 animate-in fade-in-0 zoom-in-95 active:scale-90"
            disabled={pending || !hasText || aiLed}
            onClick={() => {
              // A long-press already opened the schedule popover — swallow the
              // trailing click so it doesn't also send.
              if (longPressFired.current) {
                longPressFired.current = false
                return
              }
              submit()
            }}
            onPointerDown={startLongPress}
            onPointerUp={clearLongPress}
            onPointerLeave={clearLongPress}
            onContextMenu={(e) => {
              // Suppress the mobile long-press context menu so it doesn't fight
              // the "schedule" gesture.
              if (canSchedule && hasText) e.preventDefault()
            }}
            aria-label="Отправить"
            title={
              canSchedule
                ? 'Отправить · удерживайте, чтобы запланировать'
                : 'Отправить'
            }
          >
            <SendHorizonal className="size-4" />
          </Button>
        )}

        {/* Отложенная отправка (Telegram): контролируемый попап, привязанный к
            кнопке отправки; открывается долгим нажатием, не при редактировании. */}
        {canSchedule ? (
          <ScheduleSendPopover
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
            anchor={sendBtnRef}
            onSchedule={(iso) => {
              const body = text.trim()
              if (!body) return
              onScheduleSend(body, iso)
              setText('')
              persistRef.current('')
              requestAnimationFrame(resizeComposer)
            }}
          />
        ) : null}
      </form>
    </div>
  )
})
