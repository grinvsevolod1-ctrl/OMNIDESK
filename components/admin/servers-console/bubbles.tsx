'use client'

import { memo, useState } from 'react'
import { Check, Copy, Plus, Server, ServerCog } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ExecutedAction } from '@/lib/servers-console/assistant'
import type { ChatMessage } from './chat-types'

/* ------------------------------ Status strip ---------------------------- */

export function StatusStrip({
  serverCount,
  onlineCount,
  workerOnline,
  onNewChat,
}: {
  serverCount: number
  onlineCount: number
  workerOnline: boolean
  onNewChat: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusChip
        icon={Server}
        tone="neutral"
        label={`${serverCount} ${pluralServers(serverCount)}`}
      />
      <StatusChip
        icon={ServerCog}
        tone={onlineCount > 0 ? 'on' : 'off'}
        label={`${onlineCount} онлайн`}
      />
      <StatusChip
        icon={ServerCog}
        tone={workerOnline ? 'on' : 'off'}
        label={workerOnline ? 'Воркер в сети' : 'Воркер офлайн'}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={onNewChat}
        className="ml-auto gap-1.5 text-muted-foreground"
      >
        <Plus className="size-4" />
        Новый диалог
      </Button>
    </div>
  )
}

function StatusChip({
  icon: Icon,
  label,
  tone,
}: {
  icon: typeof Server
  label: string
  tone: 'on' | 'off' | 'neutral'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        tone === 'on' &&
          'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        tone === 'off' && 'border-border bg-muted/50 text-muted-foreground',
        tone === 'neutral' && 'border-border bg-card text-foreground',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  )
}

/* ------------------------------ Message bubbles -------------------------- */

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
          isUser ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
        )}
        aria-hidden="true"
      >
        {isUser ? (
          <span className="text-xs font-semibold">Вы</span>
        ) : (
          <ServerCog className="size-4" />
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
          {message.role === 'assistant' && message.streaming ? (
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

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
      style={{ animationDelay: delay }}
    />
  )
}

export function Bar({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block w-0.5 animate-pulse rounded-full bg-primary"
      style={{ height: '0.75rem', animationDelay: delay }}
    />
  )
}

/** Receipts for the concrete actions performed during a turn. */
export function ActionReceipts({ actions }: { actions: ExecutedAction[] }) {
  return (
    <div className="ml-9 flex flex-wrap gap-1.5 duration-300 animate-in fade-in">
      {actions.map((a, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary"
        >
          <Check className="size-3.5" />
          {a.label}
        </span>
      ))}
    </div>
  )
}
/* ------------------------------- Empty hero ----------------------------- */

export function EmptyHero() {
  return (
    <div className="flex min-h-[42vh] flex-col items-center justify-center gap-6 py-8 text-center duration-500 animate-in fade-in">
      <span className="flex size-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
        <ServerCog className="size-8" />
      </span>
      <h2 className="max-w-xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Что развернём сегодня?
      </h2>
      <p className="max-w-md text-pretty text-sm text-muted-foreground">
        Подключите сервер и дайте ссылку на репозиторий — ИИ сам зайдёт, всё
        установит и поднимет проект, показывая каждый шаг в живом логе.
      </p>
    </div>
  )
}

/* -------------------------------- Plurals ------------------------------- */

export function pluralServers(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'сервер'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'сервера'
  return 'серверов'
}
