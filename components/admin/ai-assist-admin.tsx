'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import dynamic from 'next/dynamic'
import {
  BookOpen,
  Bot,
  BrainCircuit,
  ChevronDown,
  GraduationCap,
  Highlighter,
  Loader2,
  MessagesSquare,
  Plus,
  RefreshCw,
  ScrollText,
  Send,
  Settings2,
  Sliders,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  aiDeleteKnowledgeAction,
  aiDeleteLessonAction,
  aiListKnowledgeAction,
  aiSampleConversationsAction,
  aiSaveKnowledgeAction,
  aiSaveLessonAction,
  aiSuggestReplyAction,
  aiTrainableAccountsAction,
  aiTrainOnAccountAction,
  aiUpdateSettingsAction,
} from '@/app/actions/ai-assist'
import type {
  AiAssistLesson,
  AiAssistSettings,
  KnowledgeEntry,
  TrainableAccount,
  TrainingSample,
} from '@/lib/data/ai-assist'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
// Secondary tabs (enrollment / corrections / logs) each pull their own subtree
// and are hidden behind a tab click. Load them on demand so the default
// Settings/Training view doesn't bundle them into its initial chunk.
const tabLoading = () => (
  <div className="p-6 text-sm text-muted-foreground">Загрузка…</div>
)
const AiEnrollmentTab = dynamic(
  () =>
    import('@/components/admin/ai-enrollment-tab').then((m) => m.AiEnrollmentTab),
  { loading: tabLoading },
)
const AiCorrectionsTab = dynamic(
  () =>
    import('@/components/admin/ai-corrections-tab').then(
      (m) => m.AiCorrectionsTab,
    ),
  { loading: tabLoading },
)
const AiLogsTab = dynamic(
  () => import('@/components/admin/ai-logs-tab').then((m) => m.AiLogsTab),
  { loading: tabLoading },
)

const TONE_OPTIONS = [
  { value: 'professional', label: 'Деловой' },
  { value: 'friendly', label: 'Дружелюбный' },
  { value: 'concise', label: 'Краткий' },
  { value: 'persuasive', label: 'Убедительный' },
]

// Sentinel for "use the code default model" (Select can't hold an empty value).
const DEFAULT_MODEL_VALUE = '__default__'

// Curated manager-brain models available through the Vercel AI Gateway. The
// operator can A/B these; leaving "По умолчанию" uses the code default.
const MODEL_OPTIONS = [
  { value: DEFAULT_MODEL_VALUE, label: 'По умолчанию (рекомендуется)' },
  { value: 'openai/gpt-4.1', label: 'OpenAI · GPT-4.1' },
  { value: 'openai/gpt-4.1-mini', label: 'OpenAI · GPT-4.1 mini (быстрее/дешевле)' },
  { value: 'openai/gpt-4o', label: 'OpenAI · GPT-4o' },
  { value: 'anthropic/claude-sonnet-4', label: 'Anthropic · Claude Sonnet 4' },
]

interface Props {
  initialSettings: AiAssistSettings
  initialLessons: AiAssistLesson[]
  initialLessonCount: number
  configured: boolean
}

export function AiAssistAdmin({
  initialSettings,
  initialLessons,
  initialLessonCount,
  configured,
}: Props) {
  const [settings, setSettings] = useState(initialSettings)
  const [lessons, setLessons] = useState(initialLessons)
  const [lessonCount, setLessonCount] = useState(initialLessonCount)

  const patchSettings = useCallback((next: AiAssistSettings) => {
    setSettings(next)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      {!configured ? (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
          Ключ AI Gateway не найден в переменных окружения. ИИ-ответы работать не
          будут, пока не задан <code className="font-mono">AI_GATEWAY_API_KEY</code>.
          Настройки и обучение доступны и сохранятся заранее.
        </Card>
      ) : null}

      <Tabs defaultValue="settings" className="w-full">
        <TabsList>
          <TabsTrigger value="settings">
            <Settings2 className="size-4" />
            Настройки
          </TabsTrigger>
          <TabsTrigger value="training">
            <GraduationCap className="size-4" />
            Обучение
            {lessonCount > 0 ? (
              <Badge variant="secondary" className="ml-1.5">
                {lessonCount}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="dialogs">
            <MessagesSquare className="size-4" />
            Диалоги
          </TabsTrigger>
          <TabsTrigger value="corrections">
            <Highlighter className="size-4" />
            Правки
          </TabsTrigger>
          <TabsTrigger value="logs">
            <ScrollText className="size-4" />
            Логи
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="mt-4">
          <SettingsTab settings={settings} onChange={patchSettings} />
        </TabsContent>

        <TabsContent value="training" className="mt-4">
          <TrainingTab
            lessons={lessons}
            onLessonsChange={(next) => {
              setLessons(next)
              setLessonCount(next.length)
            }}
          />
        </TabsContent>

        <TabsContent value="dialogs" className="mt-4">
          <AiEnrollmentTab />
        </TabsContent>

        <TabsContent value="corrections" className="mt-4">
          <AiCorrectionsTab />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <AiLogsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ------------------------------- Settings ------------------------------- */

function SettingsTab({
  settings,
  onChange,
}: {
  settings: AiAssistSettings
  onChange: (s: AiAssistSettings) => void
}) {
  const [persona, setPersona] = useState(settings.persona)
  const [tone, setTone] = useState(settings.tone)
  const [pending, startTransition] = useTransition()

  const save = (patch: {
    enabled?: boolean
    tone?: string
    persona?: string
    model?: string
    temperature?: number
    maxTokens?: number
  }) => {
    startTransition(async () => {
      try {
        const next = await aiUpdateSettingsAction(patch)
        onChange(next)
        setPersona(next.persona)
        setTone(next.tone)
        toast.success('Сохранено')
      } catch {
        toast.error('Не удалось сохранить')
      }
    })
  }

  const dirty = persona !== settings.persona || tone !== settings.tone

  return (
    <div className="flex flex-col gap-4">
      {/* 1. The one switch that matters, stated plainly. */}
      <Card className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'mt-0.5 rounded-md p-2',
                settings.enabled
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              <Bot className="size-5" />
            </div>
            <div>
              <p className="font-medium">
                ИИ-ассистент {settings.enabled ? 'включён' : 'выключен'}
              </p>
              <p className="text-sm text-muted-foreground">
                Пока выключен, менеджеры не могут включить ИИ в диалогах и
                авто-ответы не отправляются.
              </p>
            </div>
          </div>
          <Switch
            checked={settings.enabled}
            disabled={pending}
            onCheckedChange={(v) => save({ enabled: Boolean(v) })}
          />
        </div>
      </Card>

      {/* 2. How the AI talks: tone + free-form company context. */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
            <MessagesSquare className="size-5" />
          </div>
          <div>
            <p className="font-medium">Как ИИ общается</p>
            <p className="text-sm text-muted-foreground">
              Выберите тон и опишите компанию своими словами — это главное, что
              влияет на ответы.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="ai-tone">Тон общения</Label>
          <Select value={tone} onValueChange={(v) => setTone(v ?? 'professional')}>
            <SelectTrigger id="ai-tone" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TONE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="ai-persona">О компании и правилах общения</Label>
          <Textarea
            id="ai-persona"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={7}
            placeholder="Опишите, чем занимается компания, что предлагать клиентам, как общаться и какие правила соблюдать. Этот текст всегда учитывается при генерации ответа."
          />
          <p className="text-xs text-muted-foreground">
            Например: «Мы помогаем с трудоустройством. Всегда уточняем город и
            график, предлагаем оформить заявку. Не обещаем конкретную зарплату до
            собеседования.»
          </p>
        </div>

        <div className="flex justify-end">
          <Button
            disabled={!dirty || pending}
            onClick={() => save({ tone, persona })}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Сохранить
          </Button>
        </div>
      </Card>

      {/* 3. Facts the AI must quote exactly. */}
      <KnowledgeBaseCard />

      {/* 4. Everything advanced is tucked away so the page stays calm. */}
      <AdvancedSettings settings={settings} onSave={save} pending={pending} />
    </div>
  )
}

/* --------------------------- Advanced (collapsed) ----------------------- */

/**
 * Power-user tuning kept behind a single disclosure so the default Settings view
 * stays uncluttered: model choice, temperature, token cap, and the read-only
 * playbook distilled from training.
 */
function AdvancedSettings({
  settings,
  onSave,
  pending,
}: {
  settings: AiAssistSettings
  onSave: (patch: { model?: string; temperature?: number; maxTokens?: number }) => void
  pending: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/50"
      >
        <span className="flex items-center gap-3">
          <span className="rounded-md bg-muted p-2 text-muted-foreground">
            <Sliders className="size-5" />
          </span>
          <span>
            <span className="block font-medium">Дополнительно</span>
            <span className="block text-sm text-muted-foreground">
              Модель, температура, лимит токенов и плейбук
            </span>
          </span>
        </span>
        <ChevronDown
          className={cn(
            'size-5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-border p-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-model">Модель</Label>
            <Select
              value={settings.model || DEFAULT_MODEL_VALUE}
              onValueChange={(v) =>
                onSave({ model: !v || v === DEFAULT_MODEL_VALUE ? '' : v })
              }
            >
              <SelectTrigger id="ai-model" className="w-full sm:w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Keyed by the persisted values so the local input state resets
              automatically after a save round-trips — no sync effect needed. */}
          <TuningFields
            key={`${settings.temperature}:${settings.maxTokens}`}
            temperature={settings.temperature}
            maxTokens={settings.maxTokens}
            pending={pending}
            onSave={onSave}
          />

          {settings.playbook.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" />
                <p className="text-sm font-medium">Плейбук (выведен из обучения)</p>
              </div>
              <ul className="ml-1 flex list-inside list-disc flex-col gap-1 text-sm text-muted-foreground">
                {settings.playbook.map((rule, i) => (
                  <li key={i}>{rule}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}

/**
 * Numeric tuning inputs. Local editable state is seeded once from props; the
 * parent remounts this via a `key` when persisted values change, so a saved
 * value cleanly becomes the new baseline without any state-sync effect.
 */
function TuningFields({
  temperature: initialTemperature,
  maxTokens: initialMaxTokens,
  pending,
  onSave,
}: {
  temperature: number
  maxTokens: number
  pending: boolean
  onSave: (patch: { temperature?: number; maxTokens?: number }) => void
}) {
  const [temperature, setTemperature] = useState(String(initialTemperature))
  const [maxTokens, setMaxTokens] = useState(String(initialMaxTokens))

  const dirty =
    temperature !== String(initialTemperature) ||
    maxTokens !== String(initialMaxTokens)

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="ai-temp">Температура (0–2)</Label>
          <Input
            id="ai-temp"
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Ниже — предсказуемее, выше — разнообразнее.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="ai-maxtok">Лимит токенов (50–4000)</Label>
          <Input
            id="ai-maxtok"
            type="number"
            min={50}
            max={4000}
            step={50}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Максимальная длина одного ответа.
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          disabled={!dirty || pending}
          onClick={() =>
            onSave({
              temperature: Number(temperature),
              maxTokens: Number(maxTokens),
            })
          }
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Сохранить
        </Button>
      </div>
    </>
  )
}

/* --------------------------- RAG knowledge base ------------------------- */

/**
 * Manage the manager-brain knowledge base (prices, terms, FAQ). Entries are
 * embedded server-side and retrieved by semantic similarity at reply time, so
 * the AI quotes real facts instead of hallucinating.
 */
function KnowledgeBaseCard() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [loading, startLoad] = useTransition()
  const [saving, startSave] = useTransition()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')

  const load = useCallback(() => {
    startLoad(async () => {
      try {
        setEntries(await aiListKnowledgeAction())
      } catch {
        /* silent */
      }
    })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const add = () => {
    if (!content.trim()) {
      toast.error('Введите текст факта.')
      return
    }
    startSave(async () => {
      try {
        await aiSaveKnowledgeAction({ title, content })
        setTitle('')
        setContent('')
        toast.success('Добавлено в базу знаний')
        load()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось сохранить')
      }
    })
  }

  const remove = (id: string) => {
    startSave(async () => {
      try {
        await aiDeleteKnowledgeAction(id)
        toast.success('Удалено')
        load()
      } catch {
        toast.error('Не удалось удалить')
      }
    })
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
          <BookOpen className="size-5" />
        </div>
        <div>
          <p className="font-medium">База знаний</p>
          <p className="text-sm text-muted-foreground">
            Точные факты — цены, условия, ответы на частые вопросы. ИИ подбирает
            подходящие записи по смыслу и использует их в ответах, не выдумывая
            цифры.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <Input
          placeholder="Заголовок (необязательно), напр. «Стоимость доставки»"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Textarea
          placeholder="Факт, который ИИ должен знать точно. Напр.: «Доставка по РФ — 350 ₽, бесплатно от 5000 ₽, срок 2–5 дней»."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
        />
        <div className="flex justify-end">
          <Button onClick={add} disabled={saving}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Добавить факт
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          База знаний пуста. Добавьте факты, чтобы ИИ отвечал точнее.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                {e.title ? <p className="font-medium">{e.title}</p> : null}
                <p className="text-sm text-muted-foreground">{e.content}</p>
                {!e.hasEmbedding ? (
                  <p className="mt-1 text-xs text-destructive">
                    Не проиндексировано — пока не участвует в поиске.
                  </p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => remove(e.id)}
                disabled={saving}
                aria-label="Удалить факт"
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* ------------------------------- Training ------------------------------- */

type ChatTurn = { role: 'client' | 'manager'; body: string }

function TrainingTab({
  lessons,
  onLessonsChange,
}: {
  lessons: AiAssistLesson[]
  onLessonsChange: (next: AiAssistLesson[]) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Hero: the one-click way to teach the AI a whole account's style. */}
      <TrainOnAccountCard onLessonsChange={onLessonsChange} />

      {/* Optional manual per-dialog teaching, tucked away by default. */}
      <ManualTrainer onLessonsChange={onLessonsChange} />

      {/* The resulting lesson corpus. */}
      <LessonsCard lessons={lessons} onLessonsChange={onLessonsChange} />
    </div>
  )
}

/* -------------------------- Train on an account ------------------------- */

/**
 * Point the trainer at a real messaging account: the AI reads that account's
 * manager↔client dialogs, learns its selling style, stores the strongest
 * exchanges as lessons, and re-distills the playbook.
 */
function TrainOnAccountCard({
  onLessonsChange,
}: {
  onLessonsChange: (next: AiAssistLesson[]) => void
}) {
  const [accounts, setAccounts] = useState<TrainableAccount[]>([])
  const [selected, setSelected] = useState<string>('')
  const [loading, startLoad] = useTransition()
  const [training, startTrain] = useTransition()

  useEffect(() => {
    startLoad(async () => {
      try {
        const list = await aiTrainableAccountsAction()
        setAccounts(list)
        if (list.length > 0) setSelected(list[0].channelId)
      } catch {
        // silent — the card just shows an empty state
      }
    })
  }, [])

  const train = () => {
    if (!selected) return
    startTrain(async () => {
      try {
        const res = await aiTrainOnAccountAction({ channelId: selected })
        onLessonsChange(res.lessons)
        const coverage =
          res.totalDialogs > res.dialogsAnalysed
            ? ` из ${res.totalDialogs} (взяты самые свежие; запустите ещё раз, чтобы добрать)`
            : ''
        toast.success(
          `Готово. Проанализировано диалогов — ${res.dialogsAnalysed}${coverage}, добавлено примеров — ${res.learnedExchanges}, правил в плейбуке — ${res.playbookSize}.`,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (msg === 'no_dialogs') {
          toast.error('У этого аккаунта нет диалогов с двусторонней перепиской')
        } else {
          toast.error('Не удалось обучить ИИ на аккаунте')
        }
      }
    })
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
          <BrainCircuit className="size-5" />
        </div>
        <div className="flex-1">
          <p className="font-medium">Обучить ИИ на аккаунте</p>
          <p className="text-sm text-muted-foreground">
            Выберите аккаунт — ИИ разберёт переписки менеджеров с клиентами,
            переймёт их стиль и начнёт так же вести новых клиентов: дожимать,
            отрабатывать возражения и доводить до заявки.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={selected}
          onValueChange={(v) => setSelected(v ?? '')}
          disabled={loading || training || accounts.length === 0}
        >
          <SelectTrigger className="w-full sm:max-w-md">
            <SelectValue
              placeholder={
                loading ? 'Загрузка аккаунтов…' : 'Нет аккаунтов с диалогами'
              }
            />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.channelId} value={a.channelId}>
                {a.label} · {a.dialogCount} диал.
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          className="sm:ml-auto"
          disabled={!selected || training || loading}
          onClick={train}
        >
          {training ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <GraduationCap className="size-4" />
          )}
          Обучить
        </Button>
      </div>

      {training ? (
        <p className="flex items-center gap-2 text-sm text-primary">
          <Loader2 className="size-4 animate-spin" />
          Анализирую переписки и обучаю ИИ… не закрывайте вкладку.
        </p>
      ) : null}
    </Card>
  )
}

/* ---------------------------- Manual trainer ---------------------------- */

/**
 * Optional fine-grained teaching: pick a real conversation, write/curate the
 * ideal manager reply, and save it as a lesson. Collapsed by default because
 * training on a whole account covers most needs.
 */
function ManualTrainer({
  onLessonsChange,
}: {
  onLessonsChange: (next: AiAssistLesson[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [samples, setSamples] = useState<TrainingSample[]>([])
  const [active, setActive] = useState<TrainingSample | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [loadingSamples, startLoadSamples] = useTransition()
  const [suggesting, startSuggest] = useTransition()
  const [saving, startSave] = useTransition()

  const loadSamples = () => {
    startLoadSamples(async () => {
      try {
        const s = await aiSampleConversationsAction()
        setSamples(s)
        if (s.length === 0) toast.info('Нет свежих диалогов для тренировки')
      } catch {
        toast.error('Не удалось загрузить диалоги')
      }
    })
  }

  const pickSample = (s: TrainingSample) => {
    setActive(s)
    setDraft('')
    setNote('')
  }

  const suggest = () => {
    if (!active) return
    startSuggest(async () => {
      try {
        const reply = await aiSuggestReplyAction({ history: active.history })
        if (reply) setDraft(reply)
        else toast.error('ИИ не смог предложить ответ (проверьте ключ и настройки)')
      } catch {
        toast.error('Ошибка генерации')
      }
    })
  }

  const saveLesson = () => {
    if (!active || !draft.trim()) return
    startSave(async () => {
      try {
        const { lessons: next } = await aiSaveLessonAction({
          situation: active.lastClientMessage,
          draft: '',
          corrected: draft.trim(),
          note,
        })
        onLessonsChange(next)
        toast.success('Урок сохранён, плейбук обновлён')
        setActive(null)
        setDraft('')
        setNote('')
      } catch {
        toast.error('Не удалось сохранить урок')
      }
    })
  }

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/50"
      >
        <span className="flex items-center gap-3">
          <span className="rounded-md bg-muted p-2 text-muted-foreground">
            <Sparkles className="size-5" />
          </span>
          <span>
            <span className="block font-medium">Ручная тренировка</span>
            <span className="block text-sm text-muted-foreground">
              Обучение на отдельном диалоге — по желанию
            </span>
          </span>
        </span>
        <ChevronDown
          className={cn(
            'size-5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-border p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Выберите переписку и сохраните образцовый ответ — он станет уроком.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={loadSamples}
              disabled={loadingSamples}
            >
              {loadingSamples ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Загрузить диалоги
            </Button>
          </div>

          {samples.length > 0 && !active ? (
            <div className="flex flex-col gap-2">
              {samples.map((s) => (
                <button
                  key={s.conversationId}
                  onClick={() => pickSample(s)}
                  className="rounded-md border border-border p-3 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span className="line-clamp-2 text-foreground">
                    {s.lastClientMessage}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {!active && samples.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Нажмите «Загрузить диалоги», чтобы выбрать реальную переписку.
            </p>
          ) : null}

          {active ? (
            <div className="flex flex-col gap-3">
              <div className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md border border-border p-3">
                {active.history.map((m, i) => (
                  <ChatBubble key={i} turn={m} />
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="ai-draft">Ответ менеджера</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={suggest}
                    disabled={suggesting}
                  >
                    {suggesting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    Предложить
                  </Button>
                </div>
                <Textarea
                  id="ai-draft"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={4}
                  placeholder="Напишите или отредактируйте образцовый ответ. Именно он сохранится как урок."
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="ai-note">Заметка (необязательно)</Label>
                <Textarea
                  id="ai-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="Почему так лучше отвечать — короткое пояснение для ИИ."
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setActive(null)
                    setDraft('')
                    setNote('')
                  }}
                >
                  Отмена
                </Button>
                <Button onClick={saveLesson} disabled={!draft.trim() || saving}>
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Сохранить урок
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}

/* ------------------------------- Lessons -------------------------------- */

function LessonsCard({
  lessons,
  onLessonsChange,
}: {
  lessons: AiAssistLesson[]
  onLessonsChange: (next: AiAssistLesson[]) => void
}) {
  const [saving, startSave] = useTransition()

  const removeLesson = (id: string) => {
    startSave(async () => {
      try {
        await aiDeleteLessonAction(id)
        onLessonsChange(lessons.filter((l) => l.id !== id))
        toast.success('Урок удалён')
      } catch {
        toast.error('Не удалось удалить')
      }
    })
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <p className="font-medium">
        Уроки{' '}
        <span className="text-sm font-normal text-muted-foreground">
          ({lessons.length})
        </span>
      </p>
      <Separator />
      {lessons.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Пока нет уроков. Обучите ИИ на аккаунте или сохраните ответ вручную —
          каждый пример делает его умнее.
        </p>
      ) : (
        <div className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto">
          {lessons.map((l) => (
            <div
              key={l.id}
              className="flex flex-col gap-1.5 rounded-md border border-border p-3 text-sm"
            >
              {l.situation ? (
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Клиент:</span>{' '}
                  {l.situation}
                </p>
              ) : null}
              <p>
                <span className="font-medium text-primary">Ответ:</span>{' '}
                {l.corrected}
              </p>
              {l.note ? (
                <p className="text-xs text-muted-foreground">{l.note}</p>
              ) : null}
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeLesson(l.id)}
                  disabled={saving}
                  aria-label="Удалить урок"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function ChatBubble({ turn }: { turn: ChatTurn }) {
  const isClient = turn.role === 'client'
  return (
    <div className={isClient ? 'flex justify-start' : 'flex justify-end'}>
      <div
        className={
          isClient
            ? 'max-w-[80%] rounded-lg rounded-bl-sm bg-muted px-3 py-2 text-sm'
            : 'max-w-[80%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground'
        }
      >
        {turn.body}
      </div>
    </div>
  )
}
