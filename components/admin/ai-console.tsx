'use client'

import { useCallback, useRef, useState, useTransition } from 'react'
import dynamic from 'next/dynamic'
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Flame,
  GraduationCap,
  Highlighter,
  Loader2,
  MessagesSquare,
  ScrollText,
  Settings2,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { AiAssistLesson, AiAssistSettings } from '@/lib/data/ai-assist'
import {
  INTENT_CATALOGUE,
  INTENT_BY_ID,
  type ConsoleIntent,
} from '@/lib/ai-console/intents'
import { aiCommandRouterAction } from '@/app/actions/ai-console'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { SettingsTab } from '@/components/admin/ai-settings-tab'
import { TrainingTab } from '@/components/admin/ai-training-tab'

// Heavier, less-frequently opened panels load on demand — the console's initial
// chunk stays lean (just the launcher + settings/training).
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

/** Icon per intent for chips and the active-panel header. */
const INTENT_ICON: Record<ConsoleIntent, LucideIcon> = {
  settings: Settings2,
  aggressiveness: Flame,
  knowledge: BookOpen,
  training: GraduationCap,
  corrections: Highlighter,
  dialogs: MessagesSquare,
  logs: ScrollText,
  help: Sparkles,
}

/** The currently opened destination. */
interface ActivePanel {
  intent: ConsoleIntent
  /** Natural-language acknowledgement shown above the panel. */
  reply: string
  /** Whether the router was confident (drives the soft-confirm hint). */
  lowConfidence: boolean
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

  const [input, setInput] = useState('')
  const [active, setActive] = useState<ActivePanel | null>(null)
  const [routing, startRouting] = useTransition()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const patchSettings = useCallback((next: AiAssistSettings) => {
    setSettings(next)
  }, [])

  // Chips open their intent directly — we already know it, so skip the router
  // (instant, no gateway call).
  const openIntent = useCallback((intent: ConsoleIntent) => {
    const meta = INTENT_BY_ID[intent]
    setActive({
      intent,
      reply: meta ? `Открываю: ${meta.label.toLowerCase()}.` : 'Готово.',
      lowConfidence: false,
    })
  }, [])

  // Free text goes through the AI router (with deterministic fallback inside).
  const runCommand = useCallback(
    (text: string) => {
      const q = text.trim()
      if (!q) return
      startRouting(async () => {
        try {
          const res = await aiCommandRouterAction(q)
          setActive({
            intent: res.intent,
            reply: res.reply,
            lowConfidence: res.intent !== 'help' && res.confidence < 0.5,
          })
          setInput('')
        } catch {
          toast.error('Не удалось распознать запрос. Попробуйте ещё раз.')
        }
      })
    },
    [],
  )

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
      runCommand(input)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!configured ? (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
          Ключ AI Gateway не найден в переменных окружения. ИИ-ответы работать не
          будут, пока не задан{' '}
          <code className="font-mono">AI_GATEWAY_API_KEY</code>. Настройки и
          обучение доступны и сохранятся заранее.
        </Card>
      ) : null}

      {/* The one command box that replaces the whole tab bar. */}
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-primary/10 p-1.5 text-primary">
            <Sparkles className="size-4" />
          </span>
          <p className="text-sm font-medium">Чем я могу помочь?</p>
        </div>

        <div className="relative">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            disabled={routing}
            placeholder="Напишите, что хотите сделать. Напр.: «покажи логи», «дожимай клиентов жёстче», «добавь факт про доставку»"
            className="resize-none pr-12"
            aria-label="Команда для ИИ-панели"
          />
          <Button
            size="icon"
            className="absolute bottom-2 right-2 size-8"
            disabled={routing || !input.trim()}
            onClick={() => runCommand(input)}
            aria-label="Выполнить"
          >
            {routing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        </div>

        {/* Quick chips — instant shortcuts to each destination. */}
        <div className="flex flex-wrap gap-2">
          {INTENT_CATALOGUE.map((meta) => {
            const Icon = INTENT_ICON[meta.intent]
            const activeChip = active?.intent === meta.intent
            return (
              <button
                key={meta.intent}
                type="button"
                onClick={() => openIntent(meta.intent)}
                disabled={routing}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  activeChip
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

      {active ? (
        <ActivePanelView
          active={active}
          settings={settings}
          onSettingsChange={patchSettings}
          lessons={lessons}
          onLessonsChange={(next) => {
            setLessons(next)
            setLessonCount(next.length)
          }}
          onBack={() => {
            setActive(null)
            inputRef.current?.focus()
          }}
        />
      ) : (
        <IdleHints lessonCount={lessonCount} onPick={runCommand} />
      )}
    </div>
  )
}

/* ------------------------------ Active panel ---------------------------- */

function ActivePanelView({
  active,
  settings,
  onSettingsChange,
  lessons,
  onLessonsChange,
  onBack,
}: {
  active: ActivePanel
  settings: AiAssistSettings
  onSettingsChange: (s: AiAssistSettings) => void
  lessons: AiAssistLesson[]
  onLessonsChange: (l: AiAssistLesson[]) => void
  onBack: () => void
}) {
  const meta = INTENT_BY_ID[active.intent]
  const Icon = INTENT_ICON[active.intent]

  return (
    <div className="flex flex-col gap-3">
      {/* Acknowledgement + back control. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 rounded-md bg-primary/10 p-1.5 text-primary">
            <Icon className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium text-pretty">{active.reply}</p>
            {active.lowConfidence ? (
              <p className="text-xs text-muted-foreground">
                Не был уверен — если это не то, выберите нужное ниже или
                переформулируйте.
              </p>
            ) : meta ? (
              <p className="text-xs text-muted-foreground">{meta.description}</p>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="shrink-0 gap-1.5"
        >
          <ArrowLeft className="size-4" />
          Назад
        </Button>
      </div>

      <PanelBody
        intent={active.intent}
        settings={settings}
        onSettingsChange={onSettingsChange}
        lessons={lessons}
        onLessonsChange={onLessonsChange}
      />
    </div>
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

/* ------------------------------ Idle hints ------------------------------ */

/**
 * Shown when nothing is open: a friendly nudge plus example commands the admin
 * can click to run through the router (so they learn the natural-language way).
 */
function IdleHints({
  lessonCount,
  onPick,
}: {
  lessonCount: number
  onPick: (text: string) => void
}) {
  // One representative example per intent (first example), deduped for variety.
  const examples = INTENT_CATALOGUE.map((m) => ({
    intent: m.intent,
    text: m.examples[0],
    icon: INTENT_ICON[m.intent],
  }))

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <p className="font-medium text-pretty">
          Просто напишите, что нужно — я открою нужный раздел
        </p>
        <p className="text-sm text-muted-foreground text-pretty">
          Больше нет вкладок. Опишите задачу своими словами, а я пойму и покажу
          результат.
          {lessonCount > 0
            ? ` В обучении уже ${lessonCount} ${pluralLessons(lessonCount)}.`
            : ''}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Примеры команд
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {examples.map((ex) => {
            const Icon = ex.icon
            return (
              <button
                key={ex.intent}
                type="button"
                onClick={() => onPick(ex.text)}
                className="flex items-center gap-2 rounded-lg border border-border p-3 text-left text-sm transition-colors hover:bg-muted/60"
              >
                <span className="rounded-md bg-muted p-1.5 text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <span className="text-pretty">«{ex.text}»</span>
              </button>
            )
          })}
        </div>
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
