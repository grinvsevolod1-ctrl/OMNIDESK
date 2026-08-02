'use client'

import { memo, useState } from 'react'
import {
  BrainCircuit,
  Check,
  Copy,
  FileDown,
  Flame,
  GraduationCap,
  Plus,
  Power,
  Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { AiAssistSettings } from '@/lib/data/ai-assist'
import {
  AGGRESSIVENESS_LABELS,
  type AssistantReport,
  type ExecutedAction,
} from '@/lib/ai-console/assistant'
import { ACTION_ICON, TONE_LABEL, type ChatMessage } from './chat-types'

/* ------------------------------ Status strip ---------------------------- */

export function StatusStrip({
  settings,
  lessonCount,
  hasChat,
  onNewChat,
}: {
  settings: AiAssistSettings
  lessonCount: number
  hasChat: boolean
  onNewChat: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusChip
        icon={Power}
        tone={settings.enabled ? 'on' : 'off'}
        label={settings.enabled ? 'ИИ включён' : 'ИИ выключен'}
      />
      <StatusChip
        icon={BrainCircuit}
        tone="neutral"
        label={TONE_LABEL[settings.tone] ?? settings.tone}
      />
      <StatusChip
        icon={Flame}
        tone="neutral"
        label={
          AGGRESSIVENESS_LABELS[settings.aggressiveness] ?? 'Сбалансированный'
        }
      />
      <StatusChip
        icon={GraduationCap}
        tone="neutral"
        label={`${lessonCount} ${pluralLessons(lessonCount)}`}
      />
      {hasChat ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewChat}
          className="ml-auto gap-1.5 text-muted-foreground"
        >
          <Plus className="size-4" />
          Новый диалог
        </Button>
      ) : null}
    </div>
  )
}

function StatusChip({
  icon: Icon,
  label,
  tone,
}: {
  icon: LucideIcon
  label: string
  tone: 'on' | 'off' | 'neutral'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        tone === 'on' &&
          'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        tone === 'off' &&
          'border-border bg-muted/50 text-muted-foreground',
        tone === 'neutral' && 'border-border bg-card text-foreground',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  )
}

/* ------------------------------ Message bubbles -------------------------- */

// Memoized: the composer keeps its input in root state, so without memo every
// keystroke re-rendered every bubble in the thread (laggy typing on mobile).
export const MessageBubble = memo(function MessageBubble({
  message,
}: {
  message: ChatMessage
}) {
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Не удалось скопировать.')
    }
  }

  return (
    <div
      className={cn(
        'group flex gap-2.5 duration-300 animate-in fade-in slide-in-from-bottom-2',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
          isUser
            ? 'bg-muted text-muted-foreground'
            : 'bg-primary/10 text-primary',
        )}
        aria-hidden="true"
      >
        {isUser ? (
          <span className="text-xs font-semibold">Вы</span>
        ) : (
          <BrainCircuit className="size-4" />
        )}
      </span>
      <div
        className={cn(
          'flex max-w-[85%] flex-col gap-1',
          isUser ? 'items-end' : 'items-start',
        )}
      >
        <div
          className={cn(
            'rounded-2xl px-3.5 py-2.5 text-sm',
            isUser
              ? 'rounded-tr-sm bg-primary text-primary-foreground'
              : 'rounded-tl-sm bg-muted text-foreground',
          )}
        >
          {message.role === 'assistant' ? (
            message.streaming ? (
              // Live token stream: render raw text with a blinking caret; a
              // still-empty stream shows animated dots so it never looks stuck.
              message.content ? (
                <p className="whitespace-pre-wrap text-pretty leading-relaxed">
                  {message.content}
                  <span className="ml-0.5 inline-block h-4 w-0.5 -translate-y-px animate-pulse bg-foreground/70 align-middle" />
                </p>
              ) : (
                <span className="flex gap-1" aria-label="Печатает">
                  <Dot delay="0ms" />
                  <Dot delay="150ms" />
                  <Dot delay="300ms" />
                </span>
              )
            ) : (
              <AssistantText text={message.content} />
            )
          ) : (
            <p className="whitespace-pre-wrap text-pretty leading-relaxed">
              {message.content}
            </p>
          )}
        </div>
        {message.role === 'assistant' && message.content ? (
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
            aria-label="Скопировать ответ"
          >
            {copied ? (
              <>
                <Check className="size-3" />
                Скопировано
              </>
            ) : (
              <>
                <Copy className="size-3" />
                Копировать
              </>
            )}
          </button>
        ) : null}
      </div>
    </div>
  )
})

/** Typewriter reveal for assistant text (first mount only). */
function AssistantText({ text }: { text: string }) {
  // Settled (non-streaming) assistant reply. Progressive reveal is already
  // handled by the live token stream above, so this just renders the final text.
  return (
    <p className="whitespace-pre-wrap text-pretty leading-relaxed">{text}</p>
  )
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
      style={{ animationDelay: delay }}
    />
  )
}

/** Equalizer bar for the "listening" indicator. */
export function Bar({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block w-0.5 animate-pulse rounded-full bg-primary"
      style={{ height: '0.75rem', animationDelay: delay }}
    />
  )
}

/** Contextual follow-up chips under the latest assistant turn. */
export function Suggestions({
  items,
  onPick,
}: {
  items: string[]
  onPick: (text: string) => void
}) {
  return (
    <div className="ml-9 flex flex-wrap gap-1.5 duration-300 animate-in fade-in">
      {items.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/60 hover:text-foreground"
        >
          {s}
        </button>
      ))}
    </div>
  )
}

/** Receipts for the concrete mutations performed during a turn. */
export function ActionReceipts({
  actions,
  messageId,
  undone,
  onUndo,
}: {
  actions: ExecutedAction[]
  messageId: string
  undone: Set<string>
  onUndo: (key: string, action: ExecutedAction) => void
}) {
  return (
    <div className="ml-9 flex flex-wrap gap-1.5 duration-300 animate-in fade-in">
      {actions.map((a, i) => {
        const Icon = ACTION_ICON[a.kind]
        const key = `${messageId}:${i}`
        const isUndone = undone.has(key)
        return (
          <span
            key={i}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
              isUndone
                ? 'border-border bg-muted/50 text-muted-foreground line-through'
                : 'border-primary/30 bg-primary/5 text-primary',
            )}
          >
            <Check className="size-3.5" />
            <Icon className="size-3.5" />
            {a.label}
            {a.revert && !isUndone ? (
              <button
                type="button"
                onClick={() => onUndo(key, a)}
                className="ml-1 inline-flex items-center gap-0.5 rounded-full px-1 text-primary/80 hover:text-primary"
                aria-label="Отменить изменение"
              >
                <Undo2 className="size-3" />
                Отменить
              </button>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}

/**
 * Download button for a co-pilot-generated report. The file is built entirely
 * on the client from the report payload (Blob + object URL), so nothing is
 * stored server-side and the download works offline once the turn has arrived.
 */
export function ReportDownload({ report }: { report: AssistantReport }) {
  const download = () => {
    try {
      const blob = new Blob([report.content], { type: report.mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = report.filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoke on the next tick so the click has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch {
      toast.error('Не удалось сформировать файл')
    }
  }

  return (
    <div className="ml-9 duration-300 animate-in fade-in">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={download}
        className="gap-2"
      >
        <FileDown className="size-4" />
        {`Скачать: ${report.label}`}
      </Button>
    </div>
  )
}
/**
 * Empty-state landing: intentionally just one big question and nothing else.
 * Everything situational (status, briefing, presets, panels) is summoned by the
 * conversation itself — never dumped on the first screen.
 */
export function EmptyHero() {
  return (
    <div className="flex min-h-[42vh] flex-col items-center justify-center gap-6 py-8 text-center duration-500 animate-in fade-in">
      <span className="flex size-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
        <BrainCircuit className="size-8" />
      </span>
      <h2 className="max-w-xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Чем помочь с ИИ-менеджером?
      </h2>
    </div>
  )
}

/** Russian plural for the lesson counter. */
export function pluralLessons(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'урок'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'урока'
  return 'уроков'
}
