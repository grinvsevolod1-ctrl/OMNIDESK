'use client'

/**
 * Вся логика OMNIDESK OS-шелла: send-пайплайн (SSE + one-shot fallback),
 * подтверждения, история диалогов, голосовой ввод, инсайты, шорткаты и
 * автоскролл. os-shell.tsx остаётся презентационным контейнером.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ASSISTANT_HISTORY_LIMIT,
  type AssistantResult,
  type AssistantTurn,
  type PendingConfirmation,
} from '@/lib/admin-console/assistant'
import { SHELL_SECTIONS } from '@/lib/admin-console/intents'
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
import { nextMessageId, type ShellMessage, type ShellMeta } from './chat-types'
import {
  INSIGHTS_MUTED_KEY,
  getSpeechRecognition,
  type SpeechRecognitionLike,
} from './shell-helpers'

export function useOsShell(
  savedSession: AssistantTurn[] | null,
  insightsCount: number,
) {
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
                  m.id === asstId && !m.content ? { ...m, status: label } : m,
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
              if (attempt === 0) await new Promise((r) => setTimeout(r, 600))
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
    // Feature detection must run client-side only (hydration-safe).
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
    if (insightsCount === 0) return
    try {
      const today = new Date().toDateString()
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInsightsVisible(localStorage.getItem(INSIGHTS_MUTED_KEY) !== today)
    } catch {
      setInsightsVisible(true)
    }
  }, [insightsCount])

  const dismissInsights = useCallback(() => {
    setInsightsVisible(false)
    try {
      localStorage.setItem(INSIGHTS_MUTED_KEY, new Date().toDateString())
    } catch {
      /* private mode — session-only dismissal */
    }
  }, [])

  return {
    // feed state
    messages,
    busy,
    confirmBusy,
    input,
    setInput,
    inputRef,
    scrollRef,
    // actions
    send,
    sendCommand,
    confirm,
    cancelPending,
    toClassic,
    newDialog,
    // history
    historyOpen,
    setHistoryOpen,
    historyItems,
    openHistory,
    restoreDialog,
    // voice
    listening,
    voiceSupported,
    toggleVoice,
    // insights
    insightsVisible,
    dismissInsights,
  }
}
