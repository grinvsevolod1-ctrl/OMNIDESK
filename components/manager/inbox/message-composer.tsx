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
  type CSSProperties,
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
import {
  useMediaStaging,
  MediaTray,
  DropOverlay,
  MEDIA_ACCEPT,
} from '@/components/manager/inbox/media-staging'
import { TelemostIcon } from '@/components/channel-icons'
import { cn } from '@/lib/utils'
import type { ChannelType, QuickReply, StickerItem } from '@/lib/types'

// Native CSS auto-grow (Chromium 123+): the textarea sizes itself to its content
// with ZERO JS and ZERO layout reads, so on those browsers we never measure the
// element on the typing hot path (measuring forces a synchronous reflow of the
// whole thread, which is what made typing feel laggy). Safari/Firefox fall back
// to the coalesced rAF resize below. The style is always applied — harmless
// where unsupported — so server and client markup stay identical (no hydration
// mismatch); only the JS measure path is skipped at runtime.
const FIELD_SIZING_STYLE = { fieldSizing: 'content' } as CSSProperties
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content')

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
  onSendMediaFile: (file: File, caption: string) => void | Promise<void>
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
  // Uncontrolled input: the textarea owns its value in the DOM, mirrored here in
  // `valueRef`. Typing therefore triggers NO React re-render — a controlled
  // `value` re-rendered the whole composer subtree on every keystroke, so
  // characters painted late (the reported lag). The ONLY React state driven by
  // typing is `hasText`, and it flips just once when crossing empty↔non-empty
  // for the mic⇄send swap.
  const initialDraft = useRef(getInitialDraft(conversationId))
  const valueRef = useRef(initialDraft.current)
  const [hasText, setHasText] = useState(() =>
    Boolean(initialDraft.current.trim()),
  )
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false)
  // "Send later" popover (Telegram): opened by long-pressing the send button,
  // anchored to it — there is no separate clock button anymore.
  const [scheduleOpen, setScheduleOpen] = useState(false)
  // Telegram-style multi-file staging: pick/drop up to 10 files, caption them
  // with the textarea, then send as a batch. `sendingMedia` disables the tray
  // while the sequential upload loop runs.
  const media = useMediaStaging()
  const [sendingMedia, setSendingMedia] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const sendBtnRef = useRef<HTMLButtonElement | null>(null)
  // Long-press bookkeeping for the send button. `fired` guards the click that
  // follows a long-press so it does not also submit the message.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFired = useRef(false)

  const persistRef = useRef(onPersistDraft)
  useEffect(() => {
    persistRef.current = onPersistDraft
  }, [onPersistDraft])
  // Mirror `editing` in a ref so the persistence paths can check it without
  // adding it to their deps.
  const editingRef = useRef(editing)
  useEffect(() => {
    editingRef.current = editing
  }, [editing])

  // Debounced draft persistence, driven from the change handler (there is no
  // `text` state to key an effect on anymore). 400ms of idle keeps it off the
  // typing hot path; the unmount cleanup below covers hard reloads/crashes.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleDraftPersist = useCallback(() => {
    if (editingRef.current) return
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      persistRef.current(valueRef.current)
    }, 400)
  }, [])

  useEffect(() => {
    // On unmount (i.e. switching to another conversation) save the unsent
    // draft. If the manager was mid-edit, the input holds the EDIT text — save
    // the stashed real draft instead so the edit never leaks into drafts.
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
      persistRef.current(
        editingRef.current ? (stashedDraftRef.current ?? '') : valueRef.current,
      )
    }
  }, [])

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
    // Chromium sizes the textarea natively via `field-sizing: content` — no
    // measure, no reflow — so the hot path does nothing here.
    if (SUPPORTS_FIELD_SIZING) return
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

  // Programmatic value changes (emoji, quick reply, edit prefill, external
  // insert, clear-after-send). Writes straight to the uncontrolled textarea,
  // mirrors `valueRef`, flips `hasText` only on an empty↔non-empty transition,
  // and resizes. `focusEnd` focuses and drops the caret at the end.
  const applyValue = useCallback(
    (next: string, focusEnd = false) => {
      valueRef.current = next
      const el = composerRef.current
      if (el) {
        el.value = next
        if (focusEnd) {
          el.focus()
          const end = next.length
          el.setSelectionRange(end, end)
        }
      }
      setHasText((prev) => {
        const now = Boolean(next.trim())
        return prev === now ? prev : now
      })
      resizeComposer()
    },
    [resizeComposer],
  )

  const handleEmojiPick = useCallback(
    (emoji: string) => applyValue(valueRef.current + emoji, true),
    [applyValue],
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
      applyValue(detail.text, true)
    }
    window.addEventListener('omnidesk:composer-insert', onInsert)
    return () =>
      window.removeEventListener('omnidesk:composer-insert', onInsert)
  }, [conversationId, applyValue])

  // Entering edit mode: stash the current unsent draft and prefill the input
  // with the message being edited. Leaving edit mode (submit or cancel):
  // restore the stashed draft, Telegram-style.
  const stashedDraftRef = useRef<string | null>(null)
  const editingId = editing?.id ?? null
  const editingBody = editing?.body ?? ''
  useEffect(() => {
    if (editingId) {
      if (stashedDraftRef.current === null) {
        stashedDraftRef.current = valueRef.current
      }
      applyValue(editingBody, true)
    } else if (stashedDraftRef.current !== null) {
      applyValue(stashedDraftRef.current)
      stashedDraftRef.current = null
    }
    // editingBody intentionally read only when editingId changes: retargeting
    // to another message updates it, re-renders of the same edit do not reset
    // the manager's in-progress changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, applyValue])

  // Send the staged files as a batch. The textarea holds the single caption for
  // the whole group (Telegram album semantics) — only the first file carries it.
  // Uploads run sequentially so message order is preserved.
  const sendStagedMedia = useCallback(async () => {
    if (media.count === 0) return
    if (aiLed) {
      onBlockedInteract()
      return
    }
    const caption = valueRef.current.trim()
    const staged = media.files
    media.clear()
    if (persistTimer.current) clearTimeout(persistTimer.current)
    applyValue('')
    if (!editingRef.current) persistRef.current('')
    setSendingMedia(true)
    try {
      for (let i = 0; i < staged.length; i++) {
        await onSendMediaFile(staged[i].file, i === 0 ? caption : '')
      }
    } finally {
      setSendingMedia(false)
    }
  }, [media, aiLed, onBlockedInteract, applyValue, onSendMediaFile])

  const submit = useCallback(() => {
    if (aiLed) {
      onBlockedInteract()
      return
    }
    // Staged files take priority: a caption-only textarea becomes the group
    // caption, so we never also send it as a separate text message.
    if (media.count > 0) {
      void sendStagedMedia()
      return
    }
    const body = valueRef.current.trim()
    if (!body) return
    onSend(body)
    if (persistTimer.current) clearTimeout(persistTimer.current)
    applyValue('')
    // Clear the persisted draft immediately — otherwise the debounced persist
    // (or a stale localStorage entry) could resurrect an already-sent message.
    // Skipped while editing: submitting an edit must not wipe the stashed
    // unsent draft (it is restored by the edit effect right after).
    if (!editingRef.current) persistRef.current('')
  }, [aiLed, onSend, onBlockedInteract, applyValue, media.count, sendStagedMedia])

  function insertQuickReply(value: string) {
    const base = valueRef.current.trimEnd()
    applyValue(base ? `${base} ${value}` : value, true)
  }

  // Telegram-style send/mic swap: an empty field shows the mic (voice note),
  // any drafted text turns the button into "send". `hasText` is React state
  // flipped only on empty↔non-empty transitions (see applyValue / onChange).
  // Scheduling is only offered for Telegram and never while editing.
  const isTelegram = channelType === 'telegram'
  const canSchedule = isTelegram && !editing
  // Attachments are allowed on every channel now, but not while the AI leads the
  // thread or the manager is editing an existing message.
  const canAttach = !aiLed && !editing
  const hasStaged = media.count > 0
  // Staged files always show the send button (even with no caption); scheduling
  // a media batch is not supported, so a long-press/right-click is a no-op then.
  const showMic = isTelegram && !hasText && !hasStaged && !aiLed && !editing

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
    <div
      className={cn(
        'relative bg-card pb-safe',
        replyActive ? '' : 'border-t border-border',
      )}
      {...(canAttach ? media.dragHandlers : {})}
    >
      {canAttach ? <DropOverlay active={media.dragActive} /> : null}
      {/* Staged files awaiting send — thumbnails with per-item remove. */}
      <MediaTray
        files={media.files}
        onRemove={media.removeFile}
        disabled={sendingMedia}
      />
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
            'flex flex-1 items-end gap-0.5 rounded-3xl bg-muted px-1.5 py-1 transition-[background-color,box-shadow] duration-150 focus-within:bg-card focus-within:ring-[3px] focus-within:ring-ring/30',
            aiLed && 'opacity-60',
          )}
        >
          <EmojiPicker onPick={handleEmojiPick} />
          <textarea
            ref={composerRef}
            defaultValue={initialDraft.current}
            rows={1}
            onChange={(e) => {
              const v = e.target.value
              valueRef.current = v
              // Flip the mic⇄send swap only on empty↔non-empty transitions; the
              // updater returns the same value otherwise so React bails out and
              // typing causes NO re-render (the actual fix for the lag).
              const now = Boolean(v.trim())
              setHasText((prev) => (prev === now ? prev : now))
              scheduleResize()
              scheduleDraftPersist()
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
            style={FIELD_SIZING_STYLE}
            className={cn(
              'scrollbar-thin max-h-40 min-h-[36px] flex-1 resize-none overflow-y-auto bg-transparent px-1.5 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground',
              aiLed && 'cursor-not-allowed',
            )}
          />
          {isTelegram ? (
            <StickerPicker channelId={channelId} onSend={onSendSticker} />
          ) : null}
          {canAttach ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                accept={MEDIA_ACCEPT}
                onChange={(e) => {
                  if (e.target.files?.length) media.addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                disabled={pending || media.isFull}
                onClick={() => fileInputRef.current?.click()}
                aria-label="Прикрепить файлы"
                title="Прикрепить файлы (фото, видео, документы — до 10 за раз)"
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
            disabled={pending || sendingMedia || aiLed || (!hasText && !hasStaged)}
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
              // Desktop trigger for scheduling: right-click opens the "send
              // later" popover directly (long-press is the mobile gesture, but
              // holding a mouse button is unnatural). Also suppresses the native
              // context menu so it doesn't fight the schedule affordance.
              if (canSchedule && hasText) {
                e.preventDefault()
                clearLongPress()
                longPressFired.current = true
                setScheduleOpen(true)
              }
            }}
            aria-label="Отправить"
            title={
              canSchedule
                ? 'Отправить · удерживайте или ПКМ, чтобы запланировать'
                : 'Отправить'
            }
          >
            <SendHorizonal className="size-4" />
          </Button>
        )}

        {/* Отложенная отправка (Telegram): контролируемый ��опап, привязанный к
            кнопке отправки; открывается долгим нажатием, не при редактировании. */}
        {canSchedule ? (
          <ScheduleSendPopover
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
            anchor={sendBtnRef}
            onSchedule={(iso) => {
              const body = valueRef.current.trim()
              if (!body) return
              onScheduleSend(body, iso)
              applyValue('')
              persistRef.current('')
            }}
          />
        ) : null}
      </form>
    </div>
  )
})
