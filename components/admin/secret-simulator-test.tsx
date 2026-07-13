'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2, Play, RotateCcw, Send, Sparkles } from 'lucide-react'
import {
  simTestReplyAction,
  simTestStartAction,
  type SimTestLine,
} from '@/app/actions/client-sim'
import { ChannelIcon } from '@/components/channel-icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { ChannelType } from '@/lib/types'
import type { SimPersona } from '@/lib/client-sim/types'

/** Channel types the simulator can role-play, with human labels. */
const TEST_CHANNELS: { type: ChannelType; label: string }[] = [
  { type: 'telegram', label: 'Telegram' },
  { type: 'whatsapp', label: 'WhatsApp' },
  { type: 'vk', label: 'VK' },
  { type: 'max', label: 'MAX' },
  { type: 'livechat', label: 'Онлайн-чат' },
]

const TONE_LABEL: Record<string, string> = {
  polite: 'Вежливый',
  neutral: 'Обычный',
  rough: 'Грубый',
  mixed: 'Разный',
}

/**
 * Interactive rehearsal panel: the admin plays the manager and chats live with
 * a freshly generated AI client. Fully ephemeral — nothing is written to the
 * database or shown to real managers. The persona's tone/temperament is rolled
 * autonomously (like the live engine), so each rehearsal is a fresh character.
 */
export function SecretSimulatorTest() {
  const [channelType, setChannelType] = useState<ChannelType>('telegram')
  const [persona, setPersona] = useState<SimPersona | null>(null)
  const [lines, setLines] = useState<SimTestLine[]>([])
  const [draft, setDraft] = useState('')
  const [starting, startStart] = useTransition()
  const [replying, setReplying] = useState(false)

  const scrollerRef = useRef<HTMLDivElement>(null)

  // Keep the transcript scrolled to the newest message.
  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, replying])

  function start() {
    startStart(async () => {
      try {
        const res = await simTestStartAction({ channelType })
        setPersona(res.persona)
        setLines([{ role: 'client', body: res.opening }])
        setDraft('')
      } catch {
        toast.error('Не удалось запустить тестовый диалог')
      }
    })
  }

  function reset() {
    setPersona(null)
    setLines([])
    setDraft('')
  }

  async function send() {
    const body = draft.trim()
    if (!body || replying || !persona) return
    const next: SimTestLine[] = [...lines, { role: 'manager', body }]
    setLines(next)
    setDraft('')
    setReplying(true)
    try {
      const res = await simTestReplyAction({ persona, history: next })
      setLines((prev) => [...prev, { role: 'client', body: res.reply }])
    } catch {
      toast.error('Клиент не ответил (ошибка генерации)')
    } finally {
      setReplying(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Respect IME composition (CJK) and Safari's unreliable 229 keycode.
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    void send()
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Sparkles className="size-4 text-foreground" />
        </div>
        <div>
          <h3 className="font-semibold tracking-tight">Тестовый диалог</h3>
          <p className="max-w-prose text-sm text-muted-foreground text-pretty">
            Быстрый прогон: вы за менеджера, ИИ за клиента. Ничего не сохраняется
            и не видно реальным менеджерам — чистая проверка поведения.
          </p>
        </div>
      </div>

      {!persona ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Канал</Label>
            <div className="flex flex-wrap gap-2">
              {TEST_CHANNELS.map((c) => {
                const on = channelType === c.type
                return (
                  <button
                    key={c.type}
                    type="button"
                    onClick={() => setChannelType(c.type)}
                    className={cn(
                      'press-scale inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                      on
                        ? 'border-foreground/20 bg-foreground text-background'
                        : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <ChannelIcon type={c.type} className="size-3.5" />
                    {c.label}
                  </button>
                )
              })}
            </div>
          </div>
          <Button
            size="lg"
            className="press-scale gap-2 self-start"
            onClick={start}
            disabled={starting}
          >
            {starting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Начать диалог
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Persona header */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2 min-w-0">
              <ChannelIcon type={persona.channelType} className="size-4 shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {persona.name}
                  {persona.username && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      @{persona.username}
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {persona.age} лет · {persona.temper}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 shrink-0"
              onClick={reset}
            >
              <RotateCcw className="size-3.5" />
              Заново
            </Button>
          </div>

          {/* Transcript */}
          <div
            ref={scrollerRef}
            className="flex max-h-96 min-h-48 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-background p-3"
          >
            {lines.map((l, i) => (
              <div
                key={i}
                className={cn(
                  'flex',
                  l.role === 'manager' ? 'justify-end' : 'justify-start',
                )}
              >
                <div
                  className={cn(
                    'max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm',
                    l.role === 'manager'
                      ? 'rounded-br-sm bg-primary text-primary-foreground'
                      : 'rounded-bl-sm bg-muted text-foreground',
                  )}
                >
                  {l.body}
                </div>
              </div>
            ))}
            {replying && (
              <div className="flex justify-start">
                <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  печатает…
                </div>
              </div>
            )}
          </div>

          {/* Manager input */}
          <div className="flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ответьте как менеджер…"
              className="h-10 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              size="icon"
              className="press-scale size-10 shrink-0"
              onClick={() => void send()}
              disabled={replying || draft.trim().length === 0}
              aria-label="Отправить"
            >
              <Send className="size-4" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-[11px]">
              Тон: {TONE_LABEL[persona.tone ?? 'mixed']}
            </Badge>
            <Badge variant="secondary" className="text-[11px]">
              Характер: {persona.temper}
            </Badge>
          </div>
        </div>
      )}
    </Card>
  )
}
