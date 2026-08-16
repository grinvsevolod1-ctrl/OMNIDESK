'use client'

import { ArrowDown, ArrowUp, Clock, Pencil, Trash2 } from 'lucide-react'
import type { AutopilotSource } from '@/app/actions/autopilot'
import type { AutopilotRule } from '@/lib/autopilot/match'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { EVENT_META, WORKING_HOURS_LABELS } from './draft'

/** Read-only summary of a rule's conditions, shown on each list card. */
export function RuleSummary({
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

/** Read-only list row for a rule: reorder controls, summary, and actions. */
export function RuleCard({
  rule,
  index,
  total,
  sources,
  pending,
  onMove,
  onToggle,
  onEdit,
  onRemove,
}: {
  rule: AutopilotRule
  index: number
  total: number
  sources: AutopilotSource[]
  pending: boolean
  onMove: (index: number, dir: -1 | 1) => void
  onToggle: (id: string, next: boolean) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex items-start gap-3">
      {/* Reorder controls */}
      <div className="flex flex-col gap-1 pt-0.5">
        <button
          type="button"
          onClick={() => onMove(index, -1)}
          disabled={index === 0 || pending}
          aria-label="Поднять правило"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onMove(index, 1)}
          disabled={index === total - 1 || pending}
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
          onCheckedChange={(v) => onToggle(rule.id, Boolean(v))}
          size="sm"
          aria-label={rule.enabled ? 'Выключить правило' : 'Включить правило'}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Редактировать"
          onClick={() => onEdit(rule.id)}
        >
          <Pencil className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Удалить"
          onClick={() => onRemove(rule.id)}
        >
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </div>
    </div>
  )
}
