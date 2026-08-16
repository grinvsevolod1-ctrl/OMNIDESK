'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Bot, Flame, Loader2, MessagesSquare } from 'lucide-react'
import { aiUpdateSettingsAction } from '@/app/actions/ai-assist'
import { type AiAssistSettings } from '@/lib/data/ai-assist'
import { cn } from '@/lib/utils'
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
import { AdvancedSettings } from '@/components/admin/ai-settings-advanced'
import {
  DirectivesCard,
  KnowledgeBaseCard,
} from '@/components/admin/ai-settings-cards'

const TONE_OPTIONS = [
  { value: 'professional', label: 'Деловой' },
  { value: 'friendly', label: 'Дружелюбный' },
  { value: 'concise', label: 'Краткий' },
  { value: 'persuasive', label: 'Убедительный' },
]

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

      {/* 4. The mandate from the boss — read-only mirror of the co-pilot rules. */}
      <DirectivesCard />

      {/* 5. Facts the AI must quote exactly. */}
      <KnowledgeBaseCard />

      {/* 6. Everything advanced is tucked away so the page stays calm. */}
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

  // Scroll into view when opened via the console intent. The one-shot "pulse"
  // is a pure CSS animation (see .animate-highlight-ring) keyed off `focus`,
  // so no React state / set-state-in-effect is needed.
  useEffect(() => {
    if (!focus) return
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focus])

  const current =
    AGGRESSIVENESS_LEVELS.find((l) => l.value === value) ??
    AGGRESSIVENESS_LEVELS[2]

  return (
    <Card
      ref={ref}
      className={cn(
        'flex flex-col gap-4 p-4',
        focus && 'animate-highlight-ring',
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

/*
 * AdvancedSettings, DirectivesCard and KnowledgeBaseCard were split out into
 * ai-settings-advanced.tsx and ai-settings-cards.tsx. KnowledgeBaseCard is
 * re-exported so existing imports (including the dynamic import in
 * ai-console/inline-panel.tsx) keep working unchanged.
 */
export { KnowledgeBaseCard } from '@/components/admin/ai-settings-cards'
