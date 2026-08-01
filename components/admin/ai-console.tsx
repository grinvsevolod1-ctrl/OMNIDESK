'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  ArrowUp,
  BookOpen,
  Check,
  Copy,
  BellRing,
  FileDown,
  Flame,
  GraduationCap,
  Highlighter,
  ListChecks,
  Loader2,
  MessagesSquare,
  NotebookPen,
  Mic,
  Plus,
  Power,
  ScrollText,
  Settings2,
  ShieldAlert,
  BrainCircuit,
  Square,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { AiAssistLesson, AiAssistSettings } from '@/lib/data/ai-assist'
import { INTENT_BY_ID, type ConsoleIntent } from '@/lib/ai-console/intents'
import {
  AGGRESSIVENESS_LABELS,
  type AssistantReport,
  type AssistantResult,
  type AssistantTurn,
  type ExecutedAction,
  type PendingConfirmation,
} from '@/lib/ai-console/assistant'
import { presetSummary, type ConsolePreset } from '@/lib/ai-console/presets'
import {
  aiApplyPresetAction,
  aiAssistantAction,
  aiConfirmPendingAction,
  aiRevertSettingsAction,
} from '@/app/actions/ai-console'
import { aiSettingsAction, aiListLessonsAction } from '@/app/actions/ai-assist'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { SettingsTab } from '@/components/admin/ai-settings-tab'
import { TrainingTab } from '@/components/admin/ai-training-tab'
import { useSpeechInput } from '@/components/admin/ai-console/use-speech-input'

// Heavier, less-frequently opened panels load on demand — the console's initial
// chunk stays lean (just the composer + settings/training).
const panelLoading = () => (
  <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
    <Loader2 className="mr-2 size-4 animate-spin" />
    Загрузка…
  </div>
)
const AiEnrollmentTab = dynamic(
  () =>
    import('@/components/admin/ai-enrollment-tab').then((m) => m.AiEnrollmentTab),
  { loading: panelLoading },
)
const AiCorrectionsTab = dynamic(
  () =>
    import('@/components/admin/ai-corrections-tab').then(
      (m) => m.AiCorrectionsTab,
    ),
  { loading: panelLoading },
)
const AiLogsTab = dynamic(
  () => import('@/components/admin/ai-logs-tab').then((m) => m.AiLogsTab),
  { loading: panelLoading },
)
const KnowledgeBaseCard = dynamic(
  () =>
    import('@/components/admin/ai-settings-tab').then((m) => m.KnowledgeBaseCard),
  { loading: panelLoading },
)

/** Icon per panel for the inline-panel header and the quick-access chips. */
const PANEL_ICON: Record<ConsoleIntent, LucideIcon> = {
  settings: Settings2,
  aggressiveness: Flame,
  knowledge: BookOpen,
  training: GraduationCap,
  corrections: Highlighter,
  dialogs: MessagesSquare,
  logs: ScrollText,
  help: BrainCircuit,
}

/** Icon per executed-action receipt category. */
const ACTION_ICON: Record<ExecutedAction['kind'], LucideIcon> = {
  enabled: Power,
  tone: BrainCircuit,
  persona: Settings2,
  aggressiveness: Flame,
  model: Settings2,
  knowledge: BookOpen,
  lesson: GraduationCap,
  directive: ScrollText,
  followup: BellRing,
  dialog: MessagesSquare,
  report: FileDown,
  memory: NotebookPen,
  check: ListChecks,
}

/** Human tone labels for the status strip. */
const TONE_LABEL: Record<string, string> = {
  professional: 'Деловой',
  friendly: 'Дружелюбный',
  persuasive: 'Убедительный',
}

/** One rendered turn in the conversation. */
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  actions?: ExecutedAction[]
  openPanel?: ConsoleIntent | null
  source?: AssistantResult['source']
  /** A guarded change awaiting the admin's Confirm/Cancel (rendered as a card). */
  pending?: PendingConfirmation | null
  /** A downloadable report produced this turn (rendered as a download button). */
  report?: AssistantReport | null
  /** A high-impact preset awaiting confirmation (rendered as a card). */
  presetConfirm?: ConsolePreset | null
  /** True while tokens are still streaming into this bubble. */
  streaming?: boolean
}

/** Quick-access panels shown as a compact row (instant open, no model call). */
const QUICK_PANELS: ConsoleIntent[] = [
  'settings',
  'aggressiveness',
  'knowledge',
  'training',
  'corrections',
  'dialogs',
  'logs',
]

/** Example prompts grouped by theme for the empty-state hero. */
let idSeq = 0
const nextId = () => `m${Date.now()}_${idSeq++}`

/** Contextual follow-up chips shown under the latest assistant turn. */
function deriveSuggestions(
  settings: AiAssistSettings,
  last: ChatMessage,
): string[] {
  const out: string[] = []
  if (!settings.enabled) out.push('Включи ИИ-менеджера')
  else out.push('Как ты сейчас настроен?')
  if (settings.aggressiveness >= 3) out.push('Смягчи дожим')
  else out.push('Дожимай клиентов жёстче')
  // If the last turn opened logs, nudge toward fixing; otherwise offer content.
  if (last.openPanel === 'logs') out.push('Почему ИИ молчит?')
  else out.push('Что с ошибками ИИ?')
  out.push('Что ты знаешь про доставку?')
  return out.slice(0, 4)
}

interface Props {
  initialSettings: AiAssistSettings
  initialLessons: AiAssistLesson[]
  initialLessonCount: number
  configured: boolean
}

export function AiConsole({
  initialSettings,
  initialLessons,
  initialLessonCount,
  configured,
}: Props) {
  const [settings, setSettings] = useState(initialSettings)
  const [lessons, setLessons] = useState(initialLessons)
  const [lessonCount, setLessonCount] = useState(initialLessonCount)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [undone, setUndone] = useState<Set<string>>(() => new Set())

  // Speak assistant replies aloud (Siri-style). Off by default so text-only
  // admins are never surprised by audio.
  const [voiceMode, setVoiceMode] = useState(false)
  const [ttsSupported, setTtsSupported] = useState(false)

  // The single inline panel currently expanded, tied to the message that opened
  // it (so it renders directly under that assistant turn).
  const [activePanel, setActivePanel] = useState<ConsoleIntent | null>(null)
  const [activePanelMsgId, setActivePanelMsgId] = useState<string | null>(null)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // Monotonic token: a Stop or a newer request invalidates in-flight replies.
  const reqRef = useRef(0)
  // Aborts the in-flight streaming fetch on Stop / new request.
  const abortRef = useRef<AbortController | null>(null)

  const closePanel = useCallback(() => {
    setActivePanel(null)
    setActivePanelMsgId(null)
  }, [])

  // Keep settings/lessons in sync after the agent mutates them server-side.
  const refreshSettings = useCallback(async () => {
    try {
      const { settings: fresh, lessonCount: count } = await aiSettingsAction()
      setSettings(fresh)
      setLessonCount(count)
    } catch {
      /* non-fatal — panels still work with the last known state */
    }
  }, [])

  const refreshLessons = useCallback(async () => {
    try {
      const fresh = await aiListLessonsAction()
      setLessons(fresh)
      setLessonCount(fresh.length)
    } catch {
      /* non-fatal */
    }
  }, [])

  // Text-to-speech: only speak when the user turned voice mode on.
  const speak = useCallback(
    (text: string) => {
      if (!voiceMode || typeof window === 'undefined') return
      const synth = window.speechSynthesis
      if (!synth) return
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ru-RU'
      synth.speak(u)
    },
    [voiceMode],
  )

  useEffect(() => {
    // Post-mount capability detection: `speechSynthesis` can't be read during
    // SSR, and a render-time read would cause a hydration mismatch, so this
    // one-shot setState in an effect is the intended pattern.
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTtsSupported(true)
    }
  }, [])

  const send = useCallback(
    (raw: string) => {
      const q = raw.trim()
      if (!q || loading) return

      const userMsg: ChatMessage = { id: nextId(), role: 'user', content: q }
      const withUser = [...messages, userMsg]
      setMessages(withUser)
      setInput('')
      setLoading(true)

      const historyTurns: AssistantTurn[] = withUser.map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const token = ++reqRef.current
      const asstId = nextId()
      const controller = new AbortController()
      abortRef.current = controller

      // Pre-insert an empty assistant bubble that fills in as tokens stream.
      setMessages((prev) => [
        ...prev,
        { id: asstId, role: 'assistant', content: '', streaming: true },
      ])

      const applyResult = async (res: AssistantResult) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstId
              ? {
                  ...m,
                  content: res.reply,
                  actions: res.actions,
                  openPanel: res.openPanel,
                  source: res.source,
                  pending: res.pending ?? null,
                  report: res.report ?? null,
                  streaming: false,
                }
              : m,
          ),
        )
        if (res.openPanel) {
          setActivePanel(res.openPanel)
          setActivePanelMsgId(asstId)
        }
        if (res.settingsChanged) await refreshSettings()
        if (res.actions.some((a) => a.kind === 'lesson')) await refreshLessons()
        speak(res.reply)
      }

      ;(async () => {
        try {
          const resp = await fetch('/api/admin/ai-console/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history: historyTurns }),
            signal: controller.signal,
          })
          if (!resp.ok || !resp.body) throw new Error('stream failed')

          const reader = resp.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let streamed = ''
          let meta: Omit<AssistantResult, 'reply'> | null = null

          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            if (reqRef.current !== token) {
              await reader.cancel()
              return
            }
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const payload = trimmed.slice(5).trim()
              if (!payload || payload === '[DONE]') continue
              try {
                const evt = JSON.parse(payload) as
                  | { t: 'delta'; v: string }
                  | { t: 'meta'; v: Omit<AssistantResult, 'reply'> }
                  | { t: 'error' }
                if (evt.t === 'delta') {
                  streamed += evt.v
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === asstId ? { ...m, content: streamed } : m,
                    ),
                  )
                } else if (evt.t === 'meta') {
                  meta = evt.v
                } else if (evt.t === 'error') {
                  throw new Error('generation error')
                }
              } catch {
                /* ignore malformed line */
              }
            }
          }

          if (reqRef.current !== token) return
          await applyResult({
            reply: streamed.trim() || 'Готово.',
            actions: meta?.actions ?? [],
            openPanel: meta?.openPanel ?? null,
            settingsChanged: meta?.settingsChanged ?? false,
            pending: meta?.pending ?? null,
            report: meta?.report ?? null,
            source: meta?.source ?? 'ai',
          })
        } catch (err) {
          if (
            reqRef.current !== token ||
            (err instanceof DOMException && err.name === 'AbortError')
          ) {
            return
          }
          // Streaming failed — fall back to the one-shot server action so the
          // console never dead-ends (also covers no-JS-stream environments).
          try {
            const res = await aiAssistantAction(historyTurns)
            if (reqRef.current !== token) return
            await applyResult(res)
          } catch {
            if (reqRef.current !== token) return
            toast.error('Не удалось получить ответ. Попробуйте ещё раз.')
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstId
                  ? {
                      ...m,
                      content:
                        'Что-то пошло не так со связью. Попробуйте ещё раз.',
                      streaming: false,
                    }
                  : m,
              ),
            )
          }
        } finally {
          if (reqRef.current === token) {
            setLoading(false)
            abortRef.current = null
          }
        }
      })()
    },
    [messages, loading, refreshSettings, refreshLessons, speak],
  )

  // Stop a running generation: invalidate the in-flight token, abort the fetch,
  // and drop loading. The half-streamed bubble stays as-is.
  const stop = useCallback(() => {
    reqRef.current++
    abortRef.current?.abort()
    abortRef.current = null
    setLoading(false)
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    )
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
  }, [])

  // Start a fresh conversation.
  const newChat = useCallback(() => {
    reqRef.current++
    setMessages([])
    setInput('')
    setLoading(false)
    closePanel()
    setUndone(new Set())
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    inputRef.current?.focus()
  }, [closePanel])

  // Undo a settings change from a receipt chip.
  const undo = useCallback(
    async (key: string, action: ExecutedAction) => {
      if (!action.revert) return
      try {
        const res = await aiRevertSettingsAction(action.revert)
        if (!res.ok) {
          toast.error('Не удалось отменить изменение.')
          return
        }
        setUndone((prev) => new Set(prev).add(key))
        await refreshSettings()
        toast.success('Изменение отменено.')
      } catch {
        toast.error('Не удалось отменить изменение.')
      }
    },
    [refreshSettings],
  )

  // Confirm a guarded high-impact action (disable / max aggressiveness). On
  // success the pending card collapses and the change is applied server-side.
  const confirmPending = useCallback(
    async (msgId: string, pending: PendingConfirmation) => {
      try {
        const res = await aiConfirmPendingAction(pending)
        if (!res.ok) {
          toast.error('Не удалось применить изменение.')
          return
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  pending: null,
                  actions: [
                    ...(m.actions ?? []),
                    ...(res.action ? [res.action] : []),
                  ],
                }
              : m,
          ),
        )
        await refreshSettings()
        toast.success('Готово.')
      } catch {
        toast.error('Не удалось применить изменение.')
      }
    },
    [refreshSettings],
  )

  // Dismiss a pending confirmation without applying it.
  const dismissPending = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, pending: null } : m)),
    )
  }, [])

  // Dismiss a preset confirmation card without applying it.
  const dismissPresetConfirm = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, presetConfirm: null } : m)),
    )
  }, [])

  // Apply a one-tap preset (e.g. «Режим распродажи») — batches several settings
  // in one server call, then shows a receipt turn with an Undo.
  const applyPreset = useCallback(
    async (preset: ConsolePreset, confirmed = false) => {
      if (loading) return

      // High-impact presets («Максимальный дожим») ask first, mirroring the
      // guarded agent actions — no silent jump to maximum pressure.
      if (preset.confirm && !confirmed) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'user', content: `Включи «${preset.name}»` },
          {
            id: nextId(),
            role: 'assistant',
            content: `«${preset.name}» — это предельный дожим до документов. Подтвердите, что включаем.`,
            presetConfirm: preset,
          },
        ])
        return
      }

      const msgId = nextId()
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: `Включи «${preset.name}»` },
        {
          id: msgId,
          role: 'assistant',
          content: `Применяю пресет «${preset.name}»…`,
          streaming: true,
        },
      ])
      try {
        const res = await aiApplyPresetAction(preset.id)
        if (!res.ok) {
          toast.error('Не удалось применить пресет.')
          setMessages((prev) => prev.filter((m) => m.id !== msgId))
          return
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  content: `Готово — включил «${preset.name}». ${presetSummary(preset)}`,
                  actions: res.actions,
                  streaming: false,
                }
              : m,
          ),
        )
        await refreshSettings()
        toast.success(`Пресет «${preset.name}» применён.`)
      } catch {
        toast.error('Не удалось применить пресет.')
        setMessages((prev) => prev.filter((m) => m.id !== msgId))
      }
    },
    [loading, refreshSettings],
  )

  // Instant panel open from a quick chip — no model call, added as a turn so the
  // conversation stays coherent.
  const openPanelDirect = useCallback((intent: ConsoleIntent) => {
    const meta = INTENT_BY_ID[intent]
    const asstMsg: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: meta ? `Открыл: ${meta.label.toLowerCase()}.` : 'Готово.',
      openPanel: intent,
    }
    setMessages((prev) => [...prev, asstMsg])
    setActivePanel(intent)
    setActivePanelMsgId(asstMsg.id)
  }, [])

  const voice = useSpeechInput({
    onInterim: (text) => setInput(text),
    onFinal: (text) => send(text),
    onError: (code) => {
      // 'no-speech'/'aborted' are benign (user paused or tapped stop) — stay
      // quiet. Everything else gets a one-line explanation so a dead mic button
      // never looks like a broken feature.
      if (code === 'no-speech' || code === 'aborted') return
      const message =
        code === 'not-allowed'
          ? 'Нет доступа к микрофону. Разрешите его в настройках браузера.'
          : code === 'audio-capture'
            ? 'Микрофон не найден. Подключите его и попробуйте снова.'
            : code === 'network'
              ? 'Нет связи с сервисом распознавания речи.'
              : 'Не удалось запустить голосовой ввод.'
      toast.error(message)
    },
  })

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Submit on plain Enter; Shift+Enter inserts a newline. Respect IME
    // composition (CJK) and Safari's unreliable final composition event.
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault()
      send(input)
    }
  }

  // Autofocus the composer on mount.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc closes the open inline panel.
  useEffect(() => {
    if (!activePanel) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [activePanel, closePanel])

  // Keep the newest turn / opened panel in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, activePanel])

  const hasChat = messages.length > 0
  const lastMessage = messages[messages.length - 1]
  const suggestions =
    hasChat && !loading && lastMessage?.role === 'assistant'
      ? deriveSuggestions(settings, lastMessage)
      : []

  return (
    <div className="flex flex-col gap-4">
      {/* Status is context, not a landing-screen summary: only show it once a
          conversation is underway. The empty screen stays a single question. */}
      {hasChat ? (
        <StatusStrip
          settings={settings}
          lessonCount={lessonCount}
          hasChat={hasChat}
          onNewChat={newChat}
        />
      ) : null}

      {!configured ? (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
          Ключ AI Gateway не найден. Полноценный разговор с ассистентом заработает,
          когда будет задан <code className="font-mono">AI_GATEWAY_API_KEY</code>.
          Пока я буду просто открывать нужные разделы по вашему запросу — все
          настройки и обучение доступны.
        </Card>
      ) : null}

      {/* Conversation thread (or the empty-state hero). */}
      {hasChat ? (
        <div className="flex flex-col gap-4">
          {messages.map((m) => (
            <div key={m.id} className="flex flex-col gap-3">
              <MessageBubble message={m} />
              {m.pending ? (
                <PendingCard
                  detail={m.pending.detail}
                  label={m.pending.label}
                  onConfirm={() => confirmPending(m.id, m.pending!)}
                  onDismiss={() => dismissPending(m.id)}
                />
              ) : null}
              {m.presetConfirm ? (
                <PendingCard
                  detail={presetSummary(m.presetConfirm)}
                  label={`Включить «${m.presetConfirm.name}»`}
                  onConfirm={() => {
                    const preset = m.presetConfirm!
                    dismissPresetConfirm(m.id)
                    void applyPreset(preset, true)
                  }}
                  onDismiss={() => dismissPresetConfirm(m.id)}
                />
              ) : null}
              {m.actions && m.actions.length > 0 ? (
                <ActionReceipts
                  actions={m.actions}
                  messageId={m.id}
                  undone={undone}
                  onUndo={undo}
                />
              ) : null}
              {m.report ? <ReportDownload report={m.report} /> : null}
              {m.openPanel && activePanelMsgId === m.id && activePanel ? (
                <InlinePanel
                  intent={activePanel}
                  settings={settings}
                  onSettingsChange={setSettings}
                  lessons={lessons}
                  onLessonsChange={(next) => {
                    setLessons(next)
                    setLessonCount(next.length)
                  }}
                  onClose={closePanel}
                />
              ) : null}
            </div>
          ))}
          {suggestions.length > 0 ? (
            <Suggestions items={suggestions} onPick={send} />
          ) : null}
          <div ref={bottomRef} />
        </div>
      ) : (
        <EmptyHero />
      )}

      {/* Composer — the one place you talk to the assistant. It only pins to the
          bottom once a conversation is going; on the empty screen it sits right
          under the question as the single focal element. */}
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
            onChange={(e) => setInput(e.target.value)}
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
                onClick={() => {
                  if (voiceMode && window.speechSynthesis) {
                    window.speechSynthesis.cancel()
                  }
                  setVoiceMode((v) => !v)
                }}
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
                onClick={stop}
                aria-label="Остановить генерацию"
              >
                <Square className="size-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-8"
                disabled={!input.trim()}
                onClick={() => send(input)}
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
            {QUICK_PANELS.map((intent) => {
              const meta = INTENT_BY_ID[intent]
              const Icon = PANEL_ICON[intent]
              if (!meta) return null
              return (
                <button
                  key={intent}
                  type="button"
                  onClick={() => openPanelDirect(intent)}
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
    </div>
  )
}

/* ------------------------------ Status strip ---------------------------- */

function StatusStrip({
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

function MessageBubble({ message }: { message: ChatMessage }) {
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
}

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
function Bar({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block w-0.5 animate-pulse rounded-full bg-primary"
      style={{ height: '0.75rem', animationDelay: delay }}
    />
  )
}

/** Contextual follow-up chips under the latest assistant turn. */
function Suggestions({
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
function ActionReceipts({
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
function ReportDownload({ report }: { report: AssistantReport }) {
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

/* ------------------------------ Inline panel ---------------------------- */

function InlinePanel({
  intent,
  settings,
  onSettingsChange,
  lessons,
  onLessonsChange,
  onClose,
}: {
  intent: ConsoleIntent
  settings: AiAssistSettings
  onSettingsChange: (s: AiAssistSettings) => void
  lessons: AiAssistLesson[]
  onLessonsChange: (l: AiAssistLesson[]) => void
  onClose: () => void
}) {
  const meta = INTENT_BY_ID[intent]
  const Icon = PANEL_ICON[intent]
  return (
    <Card className="ml-9 flex flex-col gap-3 border-primary/20 p-4 duration-300 animate-in fade-in slide-in-from-top-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 rounded-md bg-primary/10 p-1.5 text-primary">
            <Icon className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium">{meta?.label}</p>
            {meta ? (
              <p className="text-xs text-muted-foreground">{meta.description}</p>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="shrink-0 gap-1.5"
        >
          <X className="size-4" />
          Закрыть
        </Button>
      </div>
      <PanelBody
        intent={intent}
        settings={settings}
        onSettingsChange={onSettingsChange}
        lessons={lessons}
        onLessonsChange={onLessonsChange}
      />
    </Card>
  )
}

/** Renders the concrete panel for an intent. */
function PanelBody({
  intent,
  settings,
  onSettingsChange,
  lessons,
  onLessonsChange,
}: {
  intent: ConsoleIntent
  settings: AiAssistSettings
  onSettingsChange: (s: AiAssistSettings) => void
  lessons: AiAssistLesson[]
  onLessonsChange: (l: AiAssistLesson[]) => void
}) {
  switch (intent) {
    case 'settings':
      return <SettingsTab settings={settings} onChange={onSettingsChange} />
    case 'aggressiveness':
      return (
        <SettingsTab
          settings={settings}
          onChange={onSettingsChange}
          focus="aggressiveness"
        />
      )
    case 'knowledge':
      return <KnowledgeBaseCard />
    case 'training':
      return <TrainingTab lessons={lessons} onLessonsChange={onLessonsChange} />
    case 'corrections':
      return <AiCorrectionsTab />
    case 'dialogs':
      return <AiEnrollmentTab />
    case 'logs':
      return <AiLogsTab />
    default:
      return null
  }
}

/* -------------------------- Pending confirmation ------------------------ */

/**
 * Confirm/Cancel card for a guarded high-impact action the assistant proposed
 * but won't run until approved (disable AI, max aggressiveness).
 */
function PendingCard({
  detail,
  label,
  onConfirm,
  onDismiss,
}: {
  detail: string
  label: string
  onConfirm: () => void
  onDismiss: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="ml-9 flex flex-col gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3.5 duration-300 animate-in fade-in slide-in-from-top-1">
      <p className="flex items-start gap-2 text-sm text-pretty">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span>{detail}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => {
            setBusy(true)
            onConfirm()
          }}
          disabled={busy}
          className="gap-1.5"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          {label}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          disabled={busy}
          className="gap-1.5"
        >
          <X className="size-4" />
          Отмена
        </Button>
      </div>
    </div>
  )
}

/**
 * Empty-state landing: intentionally just one big question and nothing else.
 * Everything situational (status, briefing, presets, panels) is summoned by the
 * conversation itself — never dumped on the first screen.
 */
function EmptyHero() {
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
function pluralLessons(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'урок'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'урока'
  return 'уроков'
}
