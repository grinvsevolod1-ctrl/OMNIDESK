'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react'
import { toast } from 'sonner'
import {
  BookOpen,
  Bot,
  ChevronDown,
  Flame,
  Loader2,
  MessagesSquare,
  Plus,
  Sliders,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  aiDeleteKnowledgeAction,
  aiListKnowledgeAction,
  aiSaveKnowledgeAction,
  aiUpdateSettingsAction,
} from '@/app/actions/ai-assist'
import {
  type AiAssistSettings,
  type KnowledgeEntry,
} from '@/lib/data/ai-assist'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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

/* ------------------------------- Settings ------------------------------- */

export function SettingsTab({
  settings,
  onChange,
  focus = null,
}: {
  settings: AiAssistSettings
  onChange: (s: AiAssistSettings) => void
  /** When 'aggressiveness', scroll to + highlight the persuasion dial on mount. */
  focus?: 'aggressiveness' | null
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
    aggressiveness?: number
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

      {/* 3. How hard the "god of sales" pushes — the persuasion dial. */}
      <AggressivenessCard
        value={settings.aggressiveness}
        pending={pending}
        focus={focus === 'aggressiveness'}
        onSave={(aggressiveness) => save({ aggressiveness })}
      />

      {/* 4. Facts the AI must quote exactly. */}
      <KnowledgeBaseCard />

      {/* 5. Everything advanced is tucked away so the page stays calm. */}
      <AdvancedSettings settings={settings} onSave={save} pending={pending} />
    </div>
  )
}

/* ----------------------- Persuasion intensity dial ---------------------- */

const AGGRESSIVENESS_LEVELS: {
  value: number
  label: string
  short: string
  description: string
}[] = [
  {
    value: 0,
    label: 'Мягкий',
    short: 'Информирует',
    description:
      'Отвечает и мягко предлагает шаг, но не давит. Отступает, если клиент явно отказывается.',
  },
  {
    value: 1,
    label: 'Спокойный',
    short: 'Лёгкие касания',
    description:
      'Отрабатывает возражения с эмпатией, делает одну мягкую попытку вернуть к цели.',
  },
  {
    value: 2,
    label: 'Настойчивый',
    short: 'По умолчанию',
    description:
      'Не соглашается с возражениями, всегда возвращает к предложению и завершает шагом.',
  },
  {
    value: 3,
    label: 'Максимальный дожим',
    short: 'Бог продаж',
    description:
      'Предельно упорно ведёт к цели: заходит с новых углов, комбинирует приёмы, почти не отпускает — в рамках этики.',
  },
]

/**
 * The persuasion-intensity dial ("god of sales"). Discrete 0..3 segmented
 * control — clearer than a slider for labelled levels. Saves immediately on
 * pick. When `focus` is set (opened via the console's "агрессивность" intent),
 * it scrolls into view and pulses once so the admin lands exactly here.
 */
function AggressivenessCard({
  value,
  pending,
  focus,
  onSave,
}: {
  value: number
  pending: boolean
  focus: boolean
  onSave: (value: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [highlight, setHighlight] = useState(false)

  useEffect(() => {
    if (!focus) return
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlight(true)
    const t = setTimeout(() => setHighlight(false), 1600)
    return () => clearTimeout(t)
  }, [focus])

  const current =
    AGGRESSIVENESS_LEVELS.find((l) => l.value === value) ??
    AGGRESSIVENESS_LEVELS[2]

  return (
    <Card
      ref={ref}
      className={cn(
        'flex flex-col gap-4 p-4 transition-shadow',
        highlight && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
          <Flame className="size-5" />
        </div>
        <div>
          <p className="font-medium">Агрессивность продаж</p>
          <p className="text-sm text-muted-foreground">
            Насколько жёстко ИИ дожимает клиента до цели. Этические ограничения
            соблюдаются на любом уровне: без лжи, угроз и фальшивой срочности.
          </p>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label="Уровень агрессивности продаж"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {AGGRESSIVENESS_LEVELS.map((level) => {
          const active = level.value === value
          return (
            <button
              key={level.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={pending || active}
              onClick={() => onSave(level.value)}
              className={cn(
                'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                active
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:bg-muted/50',
                'disabled:cursor-default',
              )}
            >
              <span className="flex w-full items-center justify-between gap-1">
                <span className="text-sm font-medium">{level.label}</span>
                {active ? (
                  <Badge variant="secondary" className="shrink-0">
                    Выбрано
                  </Badge>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">{level.short}</span>
            </button>
          )
        })}
      </div>

      <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{current.label}.</span>{' '}
        {current.description}
      </p>
    </Card>
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
export function KnowledgeBaseCard() {
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
