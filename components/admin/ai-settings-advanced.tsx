'use client'

/**
 * Advanced model settings (model picker, temperature, max tokens) split out of
 * ai-settings-tab.tsx. Collapsible so casual admins never see raw model knobs.
 */

import { useState } from 'react'
import { BrainCircuit, ChevronDown, Loader2, Sliders } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type AiAssistSettings } from '@/lib/data/ai-assist'

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

export function AdvancedSettings({
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
                <BrainCircuit className="size-4 text-primary" />
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

/* ------------------------ Directives (mandate) mirror ------------------- */

/**
 * READ-ONLY view of the co-pilot-managed directives (the mandate). Rules are
 * created and edited through the co-pilot chat; here the admin can simply see
 * what is currently steering the AI manager, in priority order. Disabled rules
 * are shown greyed out and labelled so it is obvious they are not in force.
 */
