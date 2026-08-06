'use client'

import { useState, useTransition } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  Clock,
  MessageSquareDot,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createRuleAction,
  deleteRuleAction,
  reorderRulesAction,
  setAutopilotEnabledAction,
  setRuleEnabledAction,
  updateRuleAction,
  type AutopilotSource,
} from '@/app/actions/autopilot'
import {
  DEFAULT_RULE_CONFIG,
  type AutopilotEvent,
  type AutopilotRule,
  type AutopilotRuleConfig,
} from '@/lib/autopilot/match'
import { Button } from '@/components/ui/button'
import { CharCounter } from '@/components/ui/char-counter'
import { Card } from '@/components/ui/card'
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
import { EmptyState } from '@/components/page-parts'
import { cn } from '@/lib/utils'

const MAX_NAME = 80
const MAX_REPLY = 2000

/** Human-readable label + short hint for each trigger event. */
const EVENT_META: Record<AutopilotEvent, { label: string; hint: string }> = {
  first_message: {
    label: 'Первое сообщение',
    hint: 'Срабатывает на самое первое сообщение в новом диалоге — приветствие.',
  },
  any_message: {
    label: 'Любое сообщение',
    hint: 'Срабатывает на каждое входящее сообщение (удобно с условием по ключевым словам).',
  },
  no_response: {
    label: 'Менеджер долго не отвечает',
    hint: 'Срабатывает, если менеджер не ответил в течение заданного времени.',
  },
}

const EVENTS: AutopilotEvent[] = ['first_message', 'any_message', 'no_response']

const WORKING_HOURS_LABELS: Record<
  AutopilotRuleConfig['requireWorkingHours'],
  string
> = {
  any: 'В любое время',
  inside: 'Только в рабочие часы',
  outside: 'Только в нерабочее время',
}

/** A rule being edited in the form, with keywords kept as raw editable text. */
interface DraftState {
  name: string
  event: AutopilotEvent
  enabled: boolean
  sources: string[]
  keywordsText: string
  keywordMatch: AutopilotRuleConfig['keywordMatch']
  requireWorkingHours: AutopilotRuleConfig['requireWorkingHours']
  noResponseMinutes: number
  replyText: string
  delaySec: number
  oncePerConversation: boolean
}

function draftFromRule(rule: AutopilotRule): DraftState {
  return {
    name: rule.name,
    event: rule.event,
    enabled: rule.enabled,
    sources: rule.config.sources,
    keywordsText: rule.config.keywords.join(', '),
    keywordMatch: rule.config.keywordMatch,
    requireWorkingHours: rule.config.requireWorkingHours,
    noResponseMinutes: rule.config.noResponseMinutes,
    replyText: rule.config.replyText,
    delaySec: rule.config.delaySec,
    oncePerConversation: rule.config.oncePerConversation,
  }
}

function emptyDraft(): DraftState {
  return {
    name: '',
    event: 'first_message',
    enabled: true,
    sources: [],
    keywordsText: '',
    keywordMatch: DEFAULT_RULE_CONFIG.keywordMatch,
    requireWorkingHours: DEFAULT_RULE_CONFIG.requireWorkingHours,
    noResponseMinutes: DEFAULT_RULE_CONFIG.noResponseMinutes,
    replyText: '',
    delaySec: DEFAULT_RULE_CONFIG.delaySec,
    oncePerConversation: DEFAULT_RULE_CONFIG.oncePerConversation,
  }
}

/** Parse the comma/newline separated keyword text into a clean string array. */
function parseKeywords(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
}

/** Build the action payload from a draft. */
function draftToPayload(d: DraftState) {
  return {
    name: d.name,
    event: d.event,
    enabled: d.enabled,
    config: {
      sources: d.sources,
      keywords: d.event === 'no_response' ? [] : parseKeywords(d.keywordsText),
      keywordMatch: d.keywordMatch,
      requireWorkingHours: d.requireWorkingHours,
      noResponseMinutes: d.noResponseMinutes,
      replyText: d.replyText,
      delaySec: d.delaySec,
      oncePerConversation: d.oncePerConversation,
    },
  }
}

/** The create/edit form for a single rule. */
function RuleEditor({
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

/** Read-only summary of a rule's conditions, shown on each list card. */
function RuleSummary({
  rule,
  sources,
}: {
  rule: AutopilotRule
  sources: AutopilotSource[]
}) {
  const parts: string[] = [EVENT_META[rule.event].label]
  if (rule.event === 'no_response') {
    parts.push(`через ${rule.config.noResponseMinutes} мин`)
  }
  if (rule.config.keywords.length > 0) {
    const join = rule.config.keywordMatch === 'all' ? ' + ' : ' / '
    parts.push(`слова: ${rule.config.keywords.join(join)}`)
  }
  if (rule.config.requireWorkingHours !== 'any') {
    parts.push(WORKING_HOURS_LABELS[rule.config.requireWorkingHours].toLowerCase())
  }
  const sourceNames =
    rule.config.sources.length === 0
      ? 'все источники'
      : rule.config.sources
          .map((id) => sources.find((s) => s.id === id)?.name ?? '—')
          .join(', ')
  parts.push(sourceNames)
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {parts.join(' · ')}
    </p>
  )
}

export function AutopilotManager({
  initialEnabled,
  initialRules,
  sources,
}: {
  initialEnabled: boolean
  initialRules: AutopilotRule[]
  sources: AutopilotSource[]
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [rules, setRules] = useState<AutopilotRule[]>(initialRules)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const enabledCount = rules.filter((r) => r.enabled).length

  function toggleMaster(next: boolean) {
    setEnabled(next) // optimistic
    startTransition(async () => {
      const res = await setAutopilotEnabledAction(next)
      if (!res.ok) {
        setEnabled(!next)
        toast.error(res.message)
        return
      }
      toast.success(res.message)
    })
  }

  function create(draft: DraftState) {
    startTransition(async () => {
      const res = await createRuleAction(draftToPayload(draft))
      if (!res.ok || !res.rule) {
        toast.error(res.message)
        return
      }
      setRules((prev) => [...prev, res.rule as AutopilotRule])
      setCreating(false)
      toast.success(res.message)
    })
  }

  function update(id: string, draft: DraftState) {
    startTransition(async () => {
      const res = await updateRuleAction(id, draftToPayload(draft))
      if (!res.ok || !res.rule) {
        toast.error(res.message)
        return
      }
      setRules((prev) => prev.map((r) => (r.id === id ? (res.rule as AutopilotRule) : r)))
      setEditingId(null)
      toast.success(res.message)
    })
  }

  function toggleRule(id: string, next: boolean) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: next } : r)))
    startTransition(async () => {
      const res = await setRuleEnabledAction(id, next)
      if (!res.ok) {
        setRules((prev) =>
          prev.map((r) => (r.id === id ? { ...r, enabled: !next } : r)),
        )
        toast.error(res.message)
      }
    })
  }

  function remove(id: string) {
    const prev = rules
    setRules((list) => list.filter((r) => r.id !== id))
    startTransition(async () => {
      const res = await deleteRuleAction(id)
      if (!res.ok) {
        setRules(prev)
        toast.error(res.message)
        return
      }
      toast.success(res.message)
    })
  }

  function move(index: number, dir: -1 | 1) {
    const next = [...rules]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setRules(next)
    const orderedIds = next.map((r) => r.id)
    startTransition(async () => {
      const res = await reorderRulesAction(orderedIds)
      if (!res.ok) toast.error(res.message)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Master switch */}
      <Card className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-lg border',
                enabled
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-muted/40 text-muted-foreground',
              )}
            >
              <Bot className="size-4" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">Автопилот</span>
              <span className="text-xs text-muted-foreground">
                {enabled
                  ? `Включён · активных правил: ${enabledCount}`
                  : 'Выключен — автоответы не отправляются'}
              </span>
            </div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={toggleMaster}
            aria-label="Включить автопилот"
          />
        </div>
      </Card>

      {/* Create */}
      <Card className="p-4 sm:p-5">
        {creating ? (
          <RuleEditor
            initial={emptyDraft()}
            sources={sources}
            busy={pending}
            submitLabel="Создать"
            onSubmit={create}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            className="w-full justify-center border-dashed"
            onClick={() => {
              setCreating(true)
              setEditingId(null)
            }}
          >
            <Plus className="size-4" />
            Добавить правило
          </Button>
        )}
      </Card>

      {/* List */}
      {rules.length === 0 && !creating ? (
        <Card className="p-8">
          <EmptyState
            icon={MessageSquareDot}
            title="Пока нет правил"
            description="Создайте правило, чтобы автопилот отвечал на входящие автоматически — например, приветствовал новых клиентов или реагировал на ключевые слова."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rules.map((rule, i) => (
            <Card key={rule.id} className="overflow-hidden p-4">
              {editingId === rule.id ? (
                <RuleEditor
                  initial={draftFromRule(rule)}
                  sources={sources}
                  busy={pending}
                  submitLabel="Сохранить"
                  onSubmit={(draft) => update(rule.id, draft)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="flex items-start gap-3">
                  {/* Reorder controls */}
                  <div className="flex flex-col gap-1 pt-0.5">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0 || pending}
                      aria-label="Поднять правило"
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === rules.length - 1 || pending}
                      aria-label="Опустить правило"
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                  </div>

                  {/* Body */}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'truncate text-sm font-medium',
                          !rule.enabled && 'text-muted-foreground',
                        )}
                      >
                        {rule.name || EVENT_META[rule.event].label}
                      </span>
                      {rule.config.delaySec > 0 ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                          <Clock className="size-2.5" />
                          {rule.config.delaySec}с
                        </span>
                      ) : null}
                    </div>
                    <RuleSummary rule={rule} sources={sources} />
                    <p className="mt-1 line-clamp-2 rounded-md bg-muted/50 px-2 py-1 text-xs leading-relaxed text-foreground/80">
                      {rule.config.replyText}
                    </p>
                  </div>

                  {/* Controls */}
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(v) => toggleRule(rule.id, Boolean(v))}
                      size="sm"
                      aria-label={rule.enabled ? 'Выключить правило' : 'Включить правило'}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Редактировать"
                      onClick={() => {
                        setEditingId(rule.id)
                        setCreating(false)
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Удалить"
                      onClick={() => remove(rule.id)}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
