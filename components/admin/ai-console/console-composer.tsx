'use client'

/**
 * The AiConsole composer: the textarea plus its mic / TTS / send controls and
 * the quick-panel chip row. Split out of ai-console.tsx as a pure presentational
 * component — all state and handlers are passed in from the container.
 */

import type { RefObject } from 'react'
import { ArrowUp, Mic, Square, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { INTENT_BY_ID, type ConsoleIntent } from '@/lib/ai-console/intents'
import { PANEL_ICON } from '@/components/admin/ai-console/chat-types'
import { Bar } from '@/components/admin/ai-console/bubbles'

interface ComposerVoice {
  supported: boolean
  listening: boolean
  toggle: () => void
}

export function ConsoleComposer({
  inputRef,
  input,
  onInputChange,
  onKeyDown,
  loading,
  hasChat,
  voice,
  voiceMode,
  ttsSupported,
  onToggleVoiceMode,
  onStop,
  onSend,
  quickPanels,
  activePanel,
  onOpenPanel,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  input: string
  onInputChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  loading: boolean
  hasChat: boolean
  voice: ComposerVoice
  voiceMode: boolean
  ttsSupported: boolean
  onToggleVoiceMode: () => void
  onStop: () => void
  onSend: (text: string) => void
  quickPanels: ConsoleIntent[]
  activePanel: ConsoleIntent | null
  onOpenPanel: (intent: ConsoleIntent) => void
}) {
  return (
    <Card
      className={cn(
        'z-10 flex flex-col gap-3 p-3 shadow-lg',
        hasChat && 'sticky bottom-4',
      )}
    >
      {voice.listening ? (
        <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary duration-300 animate-in fade-in">
          <span className="flex gap-0.5" aria-hidden="true">
            <Bar delay="0ms" />
            <Bar delay="120ms" />
            <Bar delay="240ms" />
          </span>
          Слушаю… говорите
        </div>
      ) : null}
      <div className="relative">
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={loading}
          placeholder="Напишите, что сделать с ИИ-менеджером…"
          className="resize-none pr-32"
          aria-label="Сообщение ассистенту ИИ-менеджера"
        />
        <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
          {ttsSupported ? (
            <Button
              type="button"
              size="icon"
              variant={voiceMode ? 'default' : 'ghost'}
              className="size-8"
              onClick={onToggleVoiceMode}
              aria-label={
                voiceMode ? 'Отключить озвучку ответов' : 'Озвучивать ответы'
              }
              aria-pressed={voiceMode}
              title={voiceMode ? 'Озвучка включена' : 'Озвучивать ответы'}
            >
              {voiceMode ? (
                <Volume2 className="size-4" />
              ) : (
                <VolumeX className="size-4" />
              )}
            </Button>
          ) : null}
          {voice.supported ? (
            <Button
              type="button"
              size="icon"
              variant={voice.listening ? 'default' : 'ghost'}
              className={cn('size-8', voice.listening && 'animate-pulse')}
              onClick={voice.toggle}
              disabled={loading}
              aria-label={voice.listening ? 'Остановить запись' : 'Голосовой ввод'}
              aria-pressed={voice.listening}
            >
              <Mic className="size-4" />
            </Button>
          ) : null}
          {loading ? (
            <Button
              size="icon"
              variant="secondary"
              className="size-8"
              onClick={onStop}
              aria-label="Остановить генерацию"
            >
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-8"
              disabled={!input.trim()}
              onClick={() => onSend(input)}
              aria-label="Отправить"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Quick-access panels — instant open, no model call. Kept off the empty
          screen so the landing view is just the question and the input. */}
      {hasChat ? (
        <div className="flex flex-wrap gap-1.5">
          {quickPanels.map((intent) => {
            const meta = INTENT_BY_ID[intent]
            const Icon = PANEL_ICON[intent]
            if (!meta) return null
            return (
              <button
                key={intent}
                type="button"
                onClick={() => onOpenPanel(intent)}
                disabled={loading}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                  activePanel === intent
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {meta.label}
              </button>
            )
          })}
        </div>
      ) : null}
    </Card>
  )
}
