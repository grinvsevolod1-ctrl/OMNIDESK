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
  Sparkles,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmojiPicker, StickerPicker } from '@/components/manager/inbox/pickers'
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
}: MessageComposerProps) {
  const [text, setText] = useState(() => getInitialDraft(conversationId))
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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
    // On unmount (i.e. switching to another conversation) save the unsent draft.
    return () => persistRef.current(textRef.current)
  }, [])

  const resizeComposer = useCallback(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  const submit = useCallback(() => {
    if (aiLed) {
      onBlockedInteract()
      return
    }
    const body = text.trim()
    if (!body) return
    onSend(body)
    setText('')
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
          <Sparkles className="size-3.5 shrink-0" />
          <span className="flex-1">
            ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.
          </span>
          <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
            Отключить ИИ
          </span>
        </button>
      ) : null}

      <form
        className="flex items-end gap-1.5 p-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <EmojiPicker
          onPick={(emoji) => {
            setText((d) => d + emoji)
            requestAnimationFrame(resizeComposer)
          }}
        />
        {channelType === 'telegram' ? (
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
                }
                e.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              disabled={pending}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Прикрепить файл"
              title="Прикрепить файл (фото, видео, документ)"
            >
              <Paperclip className="size-4" />
            </Button>
          </>
        ) : null}
        {telemostEnabled ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            disabled={pending || meetingPending}
            onClick={onStartMeeting}
            aria-label="Создать видеовстречу"
            title="Создать видеовстречу в Яндекс Телемост и отправить ссылку клиенту"
          >
            {meetingPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <TelemostIcon className="size-4" />
            )}
          </Button>
        ) : null}
        <textarea
          ref={composerRef}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value)
            resizeComposer()
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
            // While the AI leads the thread the composer is locked — vibrate the
            // AI button to point the manager at the fix.
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
            'scrollbar-thin max-h-40 min-h-[40px] flex-1 resize-none rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/30',
            aiLed && 'cursor-not-allowed opacity-60',
          )}
        />
        <Button
          type="submit"
          size="icon"
          className="size-10 shrink-0 rounded-full"
          disabled={pending || !text.trim() || aiLed}
          aria-label="Отправить"
        >
          <SendHorizonal className="size-4" />
        </Button>
      </form>
    </div>
  )
})
