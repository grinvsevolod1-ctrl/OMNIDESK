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
  History,
  LayoutPanelLeft,
  LogOut,
  MessageSquarePlus,
  Mic,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Dictionaries } from '@/lib/dictionaries'
import {
  ASSISTANT_HISTORY_LIMIT,
  type AssistantResult,
  type AssistantTurn,
  type PendingConfirmation,
} from '@/lib/admin-console/assistant'
import { SHELL_SECTIONS } from '@/lib/admin-console/intents'
import type { ShellInsight } from '@/lib/admin-console/insights'
import type { ConsoleSessionArchiveItem } from '@/lib/data/console-shell'
import {
  clearShellSessionAction,
  confirmShellPendingAction,
  listShellHistoryAction,
  restoreShellSessionAction,
  runShellAssistantAction,
  saveShellSessionAction,
  setShellModeAction,
} from '@/app/actions/admin-console'
import { logoutAction } from '@/app/actions/auth'
import { nextMessageId, type ShellMessage, type ShellMeta } from './chat-types'
import { ShellHero, ShellMessageRow } from './feed'
import {
  INSIGHTS_MUTED_KEY,
  formatArchiveDate,
  getSpeechRecognition,
  sectionPrompt,
  type SpeechRecognitionLike,
} from './shell-helpers'

export function OsShell({
  dictionaries,
  insights = [],
  savedSession = null,
}: {
  dictionaries: Dictionaries
  insights?: ShellInsight[]
  savedSession?: AssistantTurn[] | null
}) {
  const router = useRouter()
  // Restore the persisted dialog (server memory) as plain text bubbles.
  // Structured panels/receipts are not replayed — they reflect live data and
  // would be stale; the text transcript preserves the conversational context.
  const [messages, setMessages] = useState<ShellMessage[]>(() =>
    (savedSession ?? []).map((t) => ({
      id: nextMessageId(),
      role: t.role,
      content: t.content,
    })),
  )
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<AssistantTurn[]>(
    (savedSession ?? []).slice(-ASSISTANT_HISTORY_LIMIT),
  )

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
                status: undefined,
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
      // Collapse the auto-grown textarea back to one row.
      if (inputRef.current) inputRef.current.style.height = ''
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
                  m.id === asstId
                    ? { ...m, content: reply, status: undefined }
                    : m,
                ),
              )
            } else if (evt.t === 'status' && typeof evt.v === 'string') {
              // Tool progress line — visible only until the first delta.
              const label = evt.v
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === asstId && !m.content
                    ? { ...m, status: label }
                    : m,
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
        // The stream died. If it already produced text, NEVER discard it —
        // a partial answer beats an error bubble every time.
        if (reply) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstId ? { ...m, content: reply, streaming: false } : m,
            ),
          )
        } else {
          // Fallback: one-shot server action (works without SSE / AI gateway),
          // with one automatic retry — transient hiccups shouldn't reach the
          // admin as an error.
          let result: AssistantResult | null = null
          for (let attempt = 0; attempt < 2 && !result; attempt++) {
            try {
              result = await runShellAssistantAction(historyRef.current)
            } catch {
              if (attempt === 0)
                await new Promise((r) => setTimeout(r, 600))
            }
          }
          if (result) {
            reply = result.reply
            const { reply: _r, ...meta } = result
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstId
                  ? { ...m, content: reply, streaming: false }
                  : m,
              ),
            )
            applyMeta(asstId, meta, reply)
            gotMeta = true
          } else {
            // Total failure (network down / server restarting). Give the
            // command back to the input so one tap retries it.
            setInput(text)
            setMessages((prev) =>
              prev.filter((m) => m.id !== asstId && m.id !== userMsg.id),
            )
            toast.error('Связь прервалась — команда возвращена в поле ввода')
            historyRef.current = historyRef.current.filter(
              (t) => !(t.role === 'user' && t.content === text),
            )
          }
        }
      } finally {
        if (reply) {
          historyRef.current = [
            ...historyRef.current.slice(-(ASSISTANT_HISTORY_LIMIT - 1)),
            { role: 'assistant', content: reply },
          ]
        }
        // Persist the dialog so a reload / other browser keeps context.
        // Fire-and-forget: memory must never slow down or break the chat.
        void saveShellSessionAction(historyRef.current)
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

  // Стабильная ссылка для мемоизированных строк ленты: инлайн-лямбда ломала
  // бы memo(ShellMessageRow) — каждый delta-кадр перерендеривал бы ВСЕ пузыри.
  const sendCommand = useCallback((prompt: string) => void send(prompt), [send])

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

  // Follow the conversation: any feed change (new message OR streaming delta)
  // pins the view to the bottom. The feed is its OWN scroll container (not the
  // page), so we set scrollTop directly — scrollIntoView on the window fought
  // with the sticky command bar and left the last answer hidden behind it.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const toClassic = useCallback(async () => {
    try {
      await setShellModeAction(false)
    } catch {
      // Cookie may still have been set; the hard reload below re-reads it.
    }
    // FULL page navigation, not router.refresh(): the client Router Cache can
    // serve a stale RSC payload for /admin, which made the toggle look broken
    // («старая версия» after switching). A hard load always re-reads the
    // cookie server-side.
    window.location.assign('/admin')
  }, [])

  const newDialog = useCallback(() => {
    setMessages([])
    historyRef.current = []
    // Server archives the current dialog before clearing — restorable later.
    void clearShellSessionAction()
    inputRef.current?.focus()
  }, [])

  /* ------------------------------ history ------------------------------ */

  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyItems, setHistoryItems] = useState<
    ConsoleSessionArchiveItem[] | null
  >(null)

  const openHistory = useCallback(async () => {
    setHistoryOpen(true)
    setHistoryItems(null)
    try {
      setHistoryItems(await listShellHistoryAction())
    } catch {
      setHistoryItems([])
    }
  }, [])

  const restoreDialog = useCallback(async (archiveId: string) => {
    setHistoryOpen(false)
    try {
      const turns = await restoreShellSessionAction(archiveId)
      if (!turns) {
        toast.error('Не удалось восстановить диалог')
        return
      }
      historyRef.current = turns.slice(-ASSISTANT_HISTORY_LIMIT)
      setMessages(
        turns.map((t) => ({
          id: nextMessageId(),
          role: t.role,
          content: t.content,
        })),
      )
    } catch {
      toast.error('Не удалось восстановить диалог')
    }
  }, [])

  /* ---------------------------- voice input ---------------------------- */

  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const [voiceSupported, setVoiceSupported] = useState(false)
  useEffect(() => {
    // Feature detection must run client-side only (hydration-safe), same
    // pattern as the insights visibility check above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVoiceSupported(!!getSpeechRecognition())
  }, [])

  const toggleVoice = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const Ctor = getSpeechRecognition()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = 'ru-RU'
    rec.interimResults = true
    rec.continuous = false
    // The command the admin had typed before pressing the mic is preserved;
    // dictation appends to it.
    const base = inputRef.current?.value ?? ''
    rec.onresult = (event) => {
      let transcript = ''
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0]?.transcript ?? ''
      }
      setInput(base ? `${base} ${transcript}` : transcript)
    }
    rec.onend = () => {
      setListening(false)
      recognitionRef.current = null
      inputRef.current?.focus()
    }
    rec.onerror = () => {
      setListening(false)
      recognitionRef.current = null
    }
    recognitionRef.current = rec
    setListening(true)
    rec.start()
  }, [listening])

  // Never leave the mic hot after unmount.
  useEffect(() => () => recognitionRef.current?.stop(), [])

  /* ----------------------------- insights ----------------------------- */

  // Proactive findings are useful once, not on every visit: «Скрыть» mutes
  // them until tomorrow (per browser). Start hidden to avoid a flash, reveal
  // in an effect once localStorage confirms they weren't dismissed today.
  const [insightsVisible, setInsightsVisible] = useState(false)
  useEffect(() => {
    if (insights.length === 0) return
    try {
      const today = new Date().toDateString()
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInsightsVisible(localStorage.getItem(INSIGHTS_MUTED_KEY) !== today)
    } catch {
      setInsightsVisible(true)
    }
  }, [insights.length])

  const dismissInsights = useCallback(() => {
    setInsightsVisible(false)
    try {
      localStorage.setItem(INSIGHTS_MUTED_KEY, new Date().toDateString())
    } catch {
      /* private mode — session-only dismissal */
    }
  }, [])

  const hasChat = messages.length > 0

  /* ------------------------------ render ------------------------------ */

  return (
    <div className="od-os flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {/* Ambient light — a soft breathing top glow, like the desktop wallpaper
          bleeding through macOS glass. Pure CSS, zero JS cost. */}
      <div
        aria-hidden="true"
        className="od-ambient pointer-events-none fixed inset-x-0 top-0 h-72 bg-gradient-to-b from-primary/10 to-transparent"
      />

      {/* Titlebar */}
      <header className="z-20 shrink-0 border-b border-border bg-background/70 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex h-12 w-full max-w-4xl items-center gap-3 px-4">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
            Omnidesk OS
          </span>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:inline">
            Копилот-админка
          </span>
          <div className="ml-auto flex items-center gap-1">
            {hasChat ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={newDialog}
                aria-label="Новый диалог"
                className="gap-1.5 text-muted-foreground"
              >
                <MessageSquarePlus className="size-4" />
                <span className="hidden sm:inline">Новый диалог</span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void openHistory()}
              aria-label="История диалогов"
              className="gap-1.5 text-muted-foreground"
            >
              <History className="size-4" />
              <span className="hidden sm:inline">История</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toClassic}
              aria-label="Классический режим"
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

      {/* Scrollable feed area: the ONLY scroll container on the page. Header
          and command bar live outside it, so nothing ever slides under them
          and scrollTop-based autoscroll is exact. */}
      <div
        ref={scrollRef}
        className="flex flex-1 flex-col overflow-y-auto overscroll-contain"
      >
      {/* Section dock — pills wrap onto extra rows instead of clipping into a
          horizontal scroller (no scrollbar, always tidy). */}
      <nav
        aria-label="Разделы"
        className="mx-auto w-full max-w-4xl shrink-0 px-4 pt-4"
      >
        <ul className="flex flex-wrap justify-center gap-2">
          {SHELL_SECTIONS.filter((s) => s.id !== 'help').map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => void send(sectionPrompt(s.id, s.title))}
                className="press-scale whitespace-nowrap rounded-full border border-border bg-card/50 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-card hover:text-foreground"
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
            <ShellHero
              greeting={dictionaries.shellGreeting}
              insights={insightsVisible ? insights : []}
              onInsight={(prompt) => void send(prompt)}
              onDismissInsights={dismissInsights}
            />
            <div className="od-rise od-rise-4 flex flex-wrap justify-center gap-2">
              {dictionaries.shellQuickCommands.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => void send(c.prompt)}
                  className="press-scale rounded-full border border-border bg-card/60 px-4 py-2 text-sm text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-card hover:text-foreground"
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
              onCommand={sendCommand}
            />
          ))
        )}
      </main>
      </div>

      {/* Command field */}
      <div className="z-20 shrink-0 border-t border-border bg-background/70 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl backdrop-saturate-150">
        <form
          className="mx-auto w-full max-w-4xl px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            void send(input)
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
                    void send(input)
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
                onClick={toggleVoice}
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

      {/* Dialog history: past sessions archived by «Новый диалог». */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>История диалогов</DialogTitle>
          </DialogHeader>
          {historyItems === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Загружаю…
            </p>
          ) : historyItems.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Пока пусто — прошлые диалоги появятся здесь после «Новый диалог».
            </p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {historyItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void restoreDialog(item.id)}
                    className="w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent"
                  >
                    <span className="block truncate text-sm font-medium">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {formatArchiveDate(item.createdAt)} · сообщений:{' '}
                      {item.turnCount}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
