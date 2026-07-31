'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import dynamic from 'next/dynamic'
import {
  ArrowUp,
  BookOpen,
  Check,
  Flame,
  GraduationCap,
  Highlighter,
  Loader2,
  MessagesSquare,
  Mic,
  ScrollText,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { AiAssistLesson, AiAssistSettings } from '@/lib/data/ai-assist'
import { INTENT_BY_ID, type ConsoleIntent } from '@/lib/ai-console/intents'
import type {
  AssistantResult,
  AssistantTurn,
  ExecutedAction,
} from '@/lib/ai-console/assistant'
import { aiAssistantAction } from '@/app/actions/ai-console'
import { aiSettingsAction, aiListLessonsAction } from '@/app/actions/ai-assist'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { SettingsTab } from '@/components/admin/ai-settings-tab'
import { TrainingTab } from '@/components/admin/ai-training-tab'

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
  help: Sparkles,
}

/** Icon per executed-action receipt category. */
const ACTION_ICON: Record<ExecutedAction['kind'], LucideIcon> = {
  enabled: Settings2,
  tone: Sparkles,
  persona: Settings2,
  aggressiveness: Flame,
  model: Settings2,
  knowledge: BookOpen,
  lesson: GraduationCap,
}

/** One rendered turn in the conversation. */
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  actions?: ExecutedAction[]
  openPanel?: ConsoleIntent | null
  source?: AssistantResult['source']
  /** Assistant bubbles typewriter-reveal on first mount only. */
  animate?: boolean
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
const PROMPT_GROUPS: { title: string; icon: LucideIcon; prompts: string[] }[] = [
  {
    title: 'Настройка',
    icon: Settings2,
    prompts: [
      'Включи ИИ-менеджера',
      'Дожимай клиентов жёстче',
      'Поменяй тон на дружелюбный',
    ],
  },
  {
    title: 'Обучение',
    icon: GraduationCap,
    prompts: [
      'Добавь факт: доставка по городу 300 ₽',
      'Добавь урок, как отвечать на «дорого»',
      'Открой обучение',
    ],
  },
  {
    title: 'Аналитика',
    icon: ScrollText,
    prompts: [
      'Расскажи, как ты сейчас настроен',
      'Что с ошибками ИИ?',
      'Объясни, что такое агрессивность продаж',
    ],
  },
]

let idSeq = 0
const nextId = () => `m${Date.now()}_${idSeq++}`

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
  const [pending, startTransition] = useTransition()

  // The single inline panel currently expanded, tied to the message that opened
  // it (so it renders directly under that assistant turn).
  const [activePanel, setActivePanel] = useState<ConsoleIntent | null>(null)
  const [activePanelMsgId, setActivePanelMsgId] = useState<string | null>(null)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

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

  const send = useCallback(
    (raw: string) => {
      const q = raw.trim()
      if (!q || pending) return

      const userMsg: ChatMessage = { id: nextId(), role: 'user', content: q }
      const withUser = [...messages, userMsg]
      setMessages(withUser)
      setInput('')

      const historyTurns: AssistantTurn[] = withUser.map((m) => ({
        role: m.role,
        content: m.content,
      }))

      startTransition(async () => {
        try {
          const res = await aiAssistantAction(historyTurns)
          const asstMsg: ChatMessage = {
            id: nextId(),
            role: 'assistant',
            content: res.reply,
            actions: res.actions,
            openPanel: res.openPanel,
            source: res.source,
            animate: true,
          }
          setMessages((prev) => [...prev, asstMsg])

          if (res.openPanel) {
            setActivePanel(res.openPanel)
            setActivePanelMsgId(asstMsg.id)
          }
          if (res.settingsChanged) await refreshSettings()
          if (res.actions.some((a) => a.kind === 'lesson')) await refreshLessons()
        } catch {
          toast.error('Не удалось получить ответ. Попробуйте ещё раз.')
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              content: 'Что-то пошло не так со связью. Попробуйте ещё раз.',
              animate: true,
            },
          ])
        }
      })
    },
    [messages, pending, refreshSettings, refreshLessons],
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

  const voice = useSpeechInput((text) => send(text))

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

  return (
    <div className="flex flex-col gap-4">
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
              {m.actions && m.actions.length > 0 ? (
                <ActionReceipts actions={m.actions} />
              ) : null}
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
          {pending ? <ThinkingBubble /> : null}
          <div ref={bottomRef} />
        </div>
      ) : (
        <EmptyHero lessonCount={lessonCount} onPick={send} />
      )}

      {/* Composer — the one place you talk to the assistant. */}
      <Card className="sticky bottom-4 z-10 flex flex-col gap-3 p-3 shadow-lg">
        <div className="relative">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            disabled={pending}
            placeholder="Спросите или скажите, что сделать с ИИ-менеджером. Напр.: «дожимай жёстче», «добавь факт про доставку», «как ты настроен?»"
            className="resize-none pr-24"
            aria-label="Сообщение ассистенту ИИ-менеджера"
          />
          <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
            {voice.supported ? (
              <Button
                type="button"
                size="icon"
                variant={voice.listening ? 'default' : 'ghost'}
                className={cn('size-8', voice.listening && 'animate-pulse')}
                onClick={voice.toggle}
                disabled={pending}
                aria-label={voice.listening ? 'Остановить запись' : 'Голосовой ввод'}
                aria-pressed={voice.listening}
              >
                <Mic className="size-4" />
              </Button>
            ) : null}
            <Button
              size="icon"
              className="size-8"
              disabled={pending || !input.trim()}
              onClick={() => send(input)}
              aria-label="Отправить"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>

        {/* Quick-access panels — instant open, no model call. */}
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
                disabled={pending}
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
      </Card>
    </div>
  )
}

/* ------------------------------ Message bubbles -------------------------- */

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div
      className={cn(
        'flex gap-2.5 duration-300 animate-in fade-in slide-in-from-bottom-2',
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
          <Sparkles className="size-4" />
        )}
      </span>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm',
          isUser
            ? 'rounded-tr-sm bg-primary text-primary-foreground'
            : 'rounded-tl-sm bg-muted text-foreground',
        )}
      >
        {message.role === 'assistant' ? (
          <AssistantText text={message.content} animate={!!message.animate} />
        ) : (
          <p className="whitespace-pre-wrap text-pretty leading-relaxed">
            {message.content}
          </p>
        )}
      </div>
    </div>
  )
}

/** Typewriter reveal for assistant text (first mount only). */
function AssistantText({
  text,
  animate,
}: {
  text: string
  animate: boolean
}) {
  const [shown, setShown] = useState(animate ? '' : text)
  useEffect(() => {
    if (!animate) {
      setShown(text)
      return
    }
    let i = 0
    const id = window.setInterval(() => {
      i += 2
      setShown(text.slice(0, i))
      if (i >= text.length) window.clearInterval(id)
    }, 12)
    return () => window.clearInterval(id)
  }, [text, animate])
  return (
    <p className="whitespace-pre-wrap text-pretty leading-relaxed">{shown}</p>
  )
}

/** The "thinking" placeholder while the agent runs. */
function ThinkingBubble() {
  return (
    <div className="flex items-center gap-2.5 duration-300 animate-in fade-in">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-4" />
      </span>
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
        <Dot delay="0ms" />
        <Dot delay="150ms" />
        <Dot delay="300ms" />
      </div>
    </div>
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

/** Receipts for the concrete mutations performed during a turn. */
function ActionReceipts({ actions }: { actions: ExecutedAction[] }) {
  return (
    <div className="ml-9 flex flex-wrap gap-1.5 duration-300 animate-in fade-in">
      {actions.map((a, i) => {
        const Icon = ACTION_ICON[a.kind]
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary"
          >
            <Check className="size-3.5" />
            <Icon className="size-3.5" />
            {a.label}
          </span>
        )
      })}
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

/* ------------------------------ Empty hero ------------------------------ */

function EmptyHero({
  lessonCount,
  onPick,
}: {
  lessonCount: number
  onPick: (text: string) => void
}) {
  return (
    <Card className="flex flex-col gap-5 p-6 duration-500 animate-in fade-in">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="size-6" />
        </span>
        <h2 className="text-lg font-semibold text-pretty">
          Ассистент ИИ-менеджера
        </h2>
        <p className="max-w-md text-sm text-muted-foreground text-pretty">
          Просто скажите, что нужно — я включу и настрою ИИ-менеджера, добавлю
          факты и уроки, объясню, как всё устроено, или открою нужный раздел.
          {lessonCount > 0
            ? ` В обучении уже ${lessonCount} ${pluralLessons(lessonCount)}.`
            : ''}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {PROMPT_GROUPS.map((group) => {
          const GroupIcon = group.icon
          return (
            <div key={group.title} className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <GroupIcon className="size-3.5" />
                {group.title}
              </p>
              {group.prompts.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPick(p)}
                  className="rounded-lg border border-border p-2.5 text-left text-sm text-pretty transition-colors hover:border-primary/40 hover:bg-muted/60"
                >
                  «{p}»
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </Card>
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

/* ------------------------------ Voice input ----------------------------- */

interface SpeechInput {
  supported: boolean
  listening: boolean
  toggle: () => void
}

/**
 * Thin wrapper over the Web Speech API (ru-RU). Auto-submits the recognised
 * phrase on a final result so it feels like talking to Siri. Degrades to
 * `supported: false` where the API is missing (e.g. Firefox), and the mic button
 * is simply not rendered.
 */
function useSpeechInput(onFinal: (text: string) => void): SpeechInput {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal

  useEffect(() => {
    if (typeof window === 'undefined') return
    const Ctor =
      (window as WindowWithSpeech).SpeechRecognition ||
      (window as WindowWithSpeech).webkitSpeechRecognition
    if (!Ctor) return
    setSupported(true)

    const rec = new Ctor()
    rec.lang = 'ru-RU'
    rec.interimResults = false
    rec.maxAlternatives = 1
    rec.onresult = (e: SpeechRecognitionEventLike) => {
      const transcript = e.results?.[0]?.[0]?.transcript?.trim()
      if (transcript) onFinalRef.current(transcript)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recognitionRef.current = rec

    return () => {
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
      recognitionRef.current = null
    }
  }, [])

  const toggle = useCallback(() => {
    const rec = recognitionRef.current
    if (!rec) return
    if (listening) {
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
      setListening(false)
      return
    }
    try {
      rec.start()
      setListening(true)
    } catch {
      setListening(false)
    }
  }, [listening])

  return useMemo(
    () => ({ supported, listening, toggle }),
    [supported, listening, toggle],
  )
}

/* Minimal typings for the non-standard Web Speech API (avoids `any`). */
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}
interface WindowWithSpeech extends Window {
  SpeechRecognition?: new () => SpeechRecognitionLike
  webkitSpeechRecognition?: new () => SpeechRecognitionLike
}
