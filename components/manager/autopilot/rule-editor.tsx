'use client'

import { useState } from 'react'
import { Check, X } from 'lucide-react'
import type { AutopilotSource } from '@/app/actions/autopilot'
import type { AutopilotEvent } from '@/lib/autopilot/match'
import { Button } from '@/components/ui/button'
import { CharCounter } from '@/components/ui/char-counter'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  EVENT_META,
  EVENTS,
  MAX_NAME,
  MAX_REPLY,
  WORKING_HOURS_LABELS,
  parseKeywords,
  type DraftState,
} from './draft'

/** The create/edit form for a single rule. */
export function RuleEditor({
  initial,
  sources,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: DraftState
  sources: AutopilotSource[]
  busy: boolean
  submitLabel: string
  onSubmit: (draft: DraftState) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftState>(initial)
  const set = <K extends keyof DraftState>(key: K, value: DraftState[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  function toggleSource(id: string) {
    setDraft((d) => ({
      ...d,
      sources: d.sources.includes(id)
        ? d.sources.filter((s) => s !== id)
        : [...d.sources, id],
    }))
  }

  const isNoResponse = draft.event === 'no_response'
  const canSubmit = draft.replyText.trim().length > 0 && !busy

  return (
    <div className="flex flex-col gap-4">
      {/* Name */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rule-name" className="text-xs text-muted-foreground">
          Название (необязательно)
        </Label>
        <Input
          id="rule-name"
          value={draft.name}
          maxLength={MAX_NAME}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Напр. Приветствие новым клиентам"
        />
      </div>

      {/* Trigger */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Когда срабатывает</Label>
        <Select
          value={draft.event}
          onValueChange={(v) => set('event', (v as AutopilotEvent) ?? 'first_message')}
        >
          <SelectTrigger className="w-full" aria-label="Событие">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVENTS.map((ev) => (
              <SelectItem key={ev} value={ev}>
                {EVENT_META[ev].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {EVENT_META[draft.event].hint}
        </p>
      </div>

      {/* No-response delay */}
      {isNoResponse ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-minutes" className="text-xs text-muted-foreground">
            Ответить, если менеджер молчит дольше (минут)
          </Label>
          <Input
            id="rule-minutes"
            type="number"
            min={1}
            max={1440}
            value={draft.noResponseMinutes}
            onChange={(e) =>
              set('noResponseMinutes', Math.max(1, Number(e.target.value) || 1))
            }
            className="w-32"
          />
        </div>
      ) : null}

      {/* Sources */}
      <div className="flex flex-col gap-2">
        <Label className="text-xs text-muted-foreground">Источники</Label>
        {sources.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Нет подключённых каналов. Правило будет применяться ко всем будущим
            источникам.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {sources.map((s) => {
                const active = draft.sources.includes(s.id)
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleSource(s.id)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {s.name}
                  </button>
                )
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {draft.sources.length === 0
                ? 'Ничего не выбрано — правило применяется ко всем источникам.'
                : `Выбрано: ${draft.sources.length}`}
            </p>
          </>
        )}
      </div>

      {/* Keywords (not for no_response) */}
      {!isNoResponse ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor="rule-keywords"
              className="text-xs text-muted-foreground"
            >
              Ключевые слова (через запятую, необязательно)
            </Label>
            <Input
              id="rule-keywords"
              value={draft.keywordsText}
              onChange={(e) => set('keywordsText', e.target.value)}
              placeholder="цена, стоимость, сколько"
            />
          </div>
          {parseKeywords(draft.keywordsText).length > 1 ? (
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Совпадение</Label>
              <Select
                value={draft.keywordMatch}
                onValueChange={(v) =>
                  set('keywordMatch', v === 'all' ? 'all' : 'any')
                }
              >
                <SelectTrigger size="sm" aria-label="Совпадение ключевых слов">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Любое из слов</SelectItem>
                  <SelectItem value="all">Все слова</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Working hours */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Рабочие часы</Label>
        <Select
          value={draft.requireWorkingHours}
          onValueChange={(v) =>
            set(
              'requireWorkingHours',
              v === 'inside' || v === 'outside' ? v : 'any',
            )
          }
        >
          <SelectTrigger className="w-full" aria-label="Условие рабочих часов">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{WORKING_HOURS_LABELS.any}</SelectItem>
            <SelectItem value="inside">{WORKING_HOURS_LABELS.inside}</SelectItem>
            <SelectItem value="outside">
              {WORKING_HOURS_LABELS.outside}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Reply text */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rule-reply" className="text-xs text-muted-foreground">
          Текст автоответа
        </Label>
        <textarea
          id="rule-reply"
          value={draft.replyText}
          maxLength={MAX_REPLY}
          rows={3}
          autoFocus
          onChange={(e) => set('replyText', e.target.value)}
          placeholder="Здравствуйте! Спасибо за обращение, менеджер скоро ответит."
          className="min-h-[80px] w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <CharCounter
          value={draft.replyText}
          max={MAX_REPLY}
          className="self-end"
        />
      </div>

      {/* Delay */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rule-delay" className="text-xs text-muted-foreground">
          Задержка перед отправкой (секунд)
        </Label>
        <Input
          id="rule-delay"
          type="number"
          min={0}
          max={60}
          value={draft.delaySec}
          onChange={(e) =>
            set('delaySec', Math.min(60, Math.max(0, Number(e.target.value) || 0)))
          }
          className="w-32"
        />
        <p className="text-[11px] text-muted-foreground">
          Небольшая пауза делает автоответ естественнее и снижает риск блокировки в
          мессенджерах.
        </p>
      </div>

      {/* Once per conversation (only meaningful for "any message") */}
      {draft.event === 'any_message' ? (
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
          <span className="flex flex-col">
            <span className="text-sm font-medium">Один раз на диалог</span>
            <span className="text-[11px] text-muted-foreground">
              Не отвечать повторно в том же диалоге.
            </span>
          </span>
          <Switch
            checked={draft.oncePerConversation}
            onCheckedChange={(v) => set('oncePerConversation', Boolean(v))}
          />
        </label>
      ) : null}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          <X className="size-4" />
          Отмена
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => onSubmit(draft)}
          disabled={!canSubmit}
        >
          <Check className="size-4" />
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
