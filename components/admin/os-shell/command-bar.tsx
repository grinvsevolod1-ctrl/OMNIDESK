'use client'

/** Командная капсула OS-шелла: textarea с автовысотой, микрофон, отправка. */

import type { RefObject } from 'react'
import { ArrowUp, Mic } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function ShellCommandBar({
  input,
  setInput,
  inputRef,
  busy,
  listening,
  voiceSupported,
  onSend,
  onToggleVoice,
}: {
  input: string
  setInput: (v: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  busy: boolean
  listening: boolean
  voiceSupported: boolean
  onSend: (text: string) => void
  onToggleVoice: () => void
}) {
  return (
    <div className="z-20 shrink-0 border-t border-border bg-background/70 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl backdrop-saturate-150">
      <form
        className="mx-auto w-full max-w-4xl px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          onSend(input)
        }}
      >
        {/* Единая капсула в духе iMessage/Siri: поле и кнопки живут ВНУТРИ
            одного стеклянного контейнера — выравнивание идеально по
            построению, кнопкам физически некуда «уехать». */}
        <div className="od-command-glow flex items-end gap-1.5 rounded-[28px] border border-input bg-card/70 py-2 pl-5 pr-2 backdrop-blur-sm">
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                // Auto-grow up to max-h; collapse back when text shrinks.
                e.target.style.height = 'auto'
                e.target.style.height = `${Math.min(e.target.scrollHeight, 176)}px`
              }}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault()
                  onSend(input)
                }
              }}
              rows={1}
              placeholder="Скомандуйте…"
              aria-label="Командное поле"
              className="max-h-44 min-h-10 w-full resize-none bg-transparent py-2 text-base leading-snug text-foreground placeholder:text-muted-foreground/60 focus:outline-none sm:placeholder:text-transparent"
            />
            {/* Desktop-only rich hint. Pure CSS (no JS/hydration dependency):
                the native placeholder stays short so it can never wrap or
                clip on narrow screens; on sm+ it turns transparent and this
                overlay shows the full example instead. */}
            {input === '' ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 hidden items-center truncate text-base leading-snug text-muted-foreground/60 sm:flex"
              >
                {'Скомандуйте: «покажи сводку», «создай менеджера»…  (⌘K)'}
              </span>
            ) : null}
          </div>
          {voiceSupported ? (
            <Button
              type="button"
              size="icon"
              variant={listening ? 'destructive' : 'ghost'}
              onClick={onToggleVoice}
              aria-label={listening ? 'Остановить запись' : 'Голосовой ввод'}
              aria-pressed={listening}
              className={cn(
                'press-scale size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground',
                listening && 'animate-pulse',
              )}
            >
              <Mic className="size-5" />
            </Button>
          ) : null}
          <Button
            type="submit"
            size="icon"
            disabled={busy || !input.trim()}
            aria-label="Отправить"
            className="press-scale size-10 shrink-0 rounded-full disabled:opacity-35"
          >
            <ArrowUp className="size-5" />
          </Button>
        </div>
      </form>
    </div>
  )
}
