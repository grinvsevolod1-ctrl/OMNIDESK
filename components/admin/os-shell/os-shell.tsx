'use client'

/**
 * OMNIDESK OS — the command shell that IS the admin panel. One Raycast-style
 * command field + a copilot with full admin powers replaces the classic tabs.
 * Dark glass theme is scoped via the `.od-os` class (globals.css), so the rest
 * of the app keeps its own theme.
 *
 * Transport: SSE stream (delta/meta/[DONE]) with a server-action one-shot
 * fallback — the shell keeps working even when streaming or the AI gateway is
 * down (deterministic keyword routing on the server).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowUp,
  LayoutPanelLeft,
  LogOut,
  Mic,
  Square,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { Dictionaries } from '@/lib/dictionaries'
import {
  ASSISTANT_HISTORY_LIMIT,
  type AssistantResult,
  type AssistantTurn,
  type PendingConfirmation,
} from '@/lib/admin-console/assistant'
import { SHELL_SECTIONS, type ShellSection } from '@/lib/admin-console/intents'
import {
  confirmShellPendingAction,
  runShellAssistantAction,
  setShellModeAction,
} from '@/app/actions/admin-console'
import { logoutAction } from '@/app/actions/auth'
import { useSpeechInput } from '@/components/admin/ai-console/use-speech-input'
import { nextMessageId, type ShellMessage, type ShellMeta } from './chat-types'
import { ShellHero, ShellMessageRow } from './feed'

export function OsShell({ dictionaries }: { dictionaries: Dictionaries }) {
  const router = useRouter()
  const [messages, setMessages] = useState<ShellMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<AssistantTurn[]>([])

  /* --------------------------- send pipeline --------------------------- */

  const applyMeta = useCallback(
    (id: string, meta: ShellMeta, reply?: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? {
                ...m,
                content: reply ?? m.content,
                streaming: false,
                actions: meta.actions,
                views: meta.views,
                pending: meta.pending ?? null,
                report: meta.report ?? null,
              }
            : m,
        ),
      )
      if (meta.openSection) {
        const info = SHELL_SECTIONS.find((s) => s.id === meta.openSection)
        if (info && info.id !== 'overview' && info.id !== 'dictionaries') {
          router.push(info.href)
        }
      }
    },
    [router],
  )

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || busy) return
      setInput('')
      setBusy(true)

      const userMsg: ShellMessage = {
        id: nextMessageId(),
        role: 'user',
        content: text,
      }
      const asstId = nextMessageId()
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: asstId, role: 'assistant', content: '', streaming: true },
      ])

      historyRef.current = [
        ...historyRef.current.slice(-(ASSISTANT_HISTORY_LIMIT - 1)),
        { role: 'user', content: text },
      ]

      let reply = ''
      let gotMeta = false
      try {
        const res = await fetch('/api/admin/console/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: historyRef.current }),
        })
        if (!res.ok || !res.body) throw new Error('stream unavailable')

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6)
            if (data === '[DONE]') continue
            let evt: { t: string; v?: unknown }
            try {
              evt = JSON.parse(data)
            } catch {
              continue
            }
            if (evt.t === 'delta' && typeof evt.v === 'string') {
              reply += evt.v
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === asstId ? { ...m, content: reply } : m,
                ),
              )
            } else if (evt.t === 'meta' && evt.v) {
              gotMeta = true
              const meta = evt.v as ShellMeta
              // If delta frames never arrived, meta carries the reply text.
              if (!reply && typeof meta.reply === 'string') reply = meta.reply
              applyMeta(asstId, meta, reply || undefined)
            } else if (evt.t === 'error') {
              throw new Error('generation failed')
            }
          }
        }
        if (!gotMeta) throw new Error('no meta')
      } catch {
        // Fallback: one-shot server action (works without SSE / AI gateway).
        try {
          const result: AssistantResult = await runShellAssistantAction(
            historyRef.current,
          )
          reply = result.reply
          const { reply: _r, ...meta } = result
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstId ? { ...m, content: reply, streaming: false } : m,
            ),
          )
          applyMeta(asstId, meta, reply)
          gotMeta = true
        } catch {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstId
                ? {
                    ...m,
                    content: 'Не получилось обработать команду. Попробуйте ещё раз.',
                    streaming: false,
                  }
                : m,
            ),
          )
        }
      } finally {
        if (reply) {
          historyRef.current = [
            ...historyRef.current.slice(-(ASSISTANT_HISTORY_LIMIT - 1)),
            { role: 'assistant', content: reply },
          ]
        }
        setBusy(false)
      }
    },
    [busy, applyMeta],
  )

  /* ----------------------------- confirm ------------------------------ */

  const confirm = useCallback(
    async (pending: PendingConfirmation) => {
      setConfirmBusy(true)
      try {
        const res = await confirmShellPendingAction(pending)
        if (res.ok) toast.success(res.message)
        else toast.error(res.message)
        // Retire the confirmation card and append a receipt line.
        setMessages((prev) =>
          prev.map((m) =>
            m.pending === pending
              ? {
                  ...m,
                  pending: null,
                  actions: res.ok
                    ? [
                        ...(m.actions ?? []),
                        { kind: 'manager', label: res.message },
                      ]
                    : m.actions,
                }
              : m,
          ),
        )
        router.refresh()
      } catch {
        toast.error('Не удалось выполнить действие')
      } finally {
        setConfirmBusy(false)
      }
    },
    [router],
  )

  const cancelPending = useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, pending: null } : m)),
    )
  }, [])

  /* ------------------------------ voice ------------------------------- */

  const speech = useSpeechInput({
    onInterim: setInput,
    onFinal: (text) => {
      setInput('')
      void send(text)
    },
    onError: (code) => {
      if (code === 'not-allowed')
        toast.error('Д��ступ к микрофону запрещён браузером')
      else if (code !== 'aborted' && code !== 'no-speech')
        toast.error('Голосовой ввод недоступен')
    },
  })

  /* ---------------------------- shortcuts ----------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const toClassic = useCallback(async () => {
    await setShellModeAction(false)
    router.refresh()
  }, [router])

  const hasChat = messages.length > 0

  /* ------------------------------ render ------------------------------ */

  return (
    <div className="od-os flex min-h-dvh flex-col bg-background text-foreground">
      {/* Ambient glow — pure decoration, kept subtle. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-64 bg-gradient-to-b from-primary/10 to-transparent"
      />

      {/* Titlebar */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-12 w-full max-w-4xl items-center gap-3 px-4">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
            Omnidesk OS
          </span>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:inline">
            Копилот-админка
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={toClassic}
              className="gap-1.5 text-muted-foreground"
            >
              <LayoutPanelLeft className="size-4" />
              <span className="hidden sm:inline">Классический режим</span>
            </Button>
            <form action={logoutAction}>
              <Button
                variant="ghost"
                size="icon"
                type="submit"
                aria-label="Выйти"
                className="text-muted-foreground"
              >
                <LogOut className="size-4" />
              </Button>
            </form>
          </div>
        </div>
      </header>

      {/* Section dock */}
      <nav
        aria-label="Разделы"
        className="mx-auto w-full max-w-4xl overflow-x-auto px-4 pt-4 scrollbar-thin"
      >
        <ul className="flex gap-1.5">
          {SHELL_SECTIONS.filter((s) => s.id !== 'help').map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => void send(sectionPrompt(s.id, s.title))}
                className="whitespace-nowrap rounded-full border border-border bg-card/50 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {s.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Feed */}
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6">
        {!hasChat ? (
          <>
            <ShellHero greeting={dictionaries.shellGreeting} />
            <div className="flex flex-wrap justify-center gap-1.5">
              {dictionaries.shellQuickCommands.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => void send(c.prompt)}
                  className="rounded-full border border-border bg-card/50 px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-card hover:text-foreground"
                >
                  {c.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          messages.map((m) => (
            <ShellMessageRow
              key={m.id}
              message={m}
              onConfirm={confirm}
              onCancelPending={cancelPending}
              confirmBusy={confirmBusy}
            />
          ))
        )}
        <div ref={bottomRef} />
      </main>

      {/* Command field */}
      <div className="sticky bottom-0 z-20 border-t border-border bg-background/85 backdrop-blur-md">
        <form
          className="mx-auto flex w-full max-w-4xl items-end gap-2 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            void send(input)
          }}
        >
          <div className="relative flex-1">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault()
                  void send(input)
                }
              }}
              rows={1}
              placeholder="Скомандуйте: «покажи сводку», «создай менеджера», «переименуй статус Ликвид»…  (⌘K)"
              aria-label="Командное поле"
              className="max-h-40 min-h-[46px] w-full resize-none rounded-xl border border-input bg-card/70 px-4 py-3 pr-11 text-sm leading-snug text-foreground placeholder:text-muted-foreground/70 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {speech.supported ? (
              <button
                type="button"
                onClick={speech.toggle}
                aria-label={
                  speech.listening ? 'Остановить запись' : 'Голосовой ввод'
                }
                className={cn(
                  'absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 transition-colors',
                  speech.listening
                    ? 'bg-destructive/15 text-destructive'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {speech.listening ? (
                  <Square className="size-4" />
                ) : (
                  <Mic className="size-4" />
                )}
              </button>
            ) : null}
          </div>
          <Button
            type="submit"
            size="icon"
            disabled={busy || !input.trim()}
            aria-label="Отправить"
            className="size-[46px] shrink-0 rounded-xl"
          >
            <ArrowUp className="size-5" />
          </Button>
        </form>
      </div>
    </div>
  )
}

/** Natural-language prompt for a dock section click. */
function sectionPrompt(id: ShellSection, title: string): string {
  switch (id) {
    case 'overview':
      return 'Покажи сводку системы'
    case 'managers':
      return 'Покажи список менеджеров'
    case 'accounts':
      return 'Покажи статусы всех аккаунтов'
    case 'finance':
      return 'Покажи финансовую сводку'
    case 'channels':
      return 'Покажи каналы'
    case 'proxies':
      return 'Покажи прокси'
    case 'contacts':
      return 'Покажи контакты по каналам'
    case 'hosting':
      return 'Открой раздел серверов'
    case 'ai':
      return 'Открой ИИ-менеджера'
    case 'dictionaries':
      return 'Покажи справочники'
    default:
      return `Открой раздел «${title}»`
  }
}
