'use client'

/**
 * AI-configuration panels: standing directives, the knowledge base list and
 * scheduled commands the copilot runs on a timer.
 */

import { asArray, EmptyNote } from './shared'

interface DirectiveRow {
  id: string
  body: string
  enabled: boolean
}

export function DirectivesPanel({ payload }: { payload: unknown }) {
  const rows = asArray<DirectiveRow>(payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <ol className="flex flex-col gap-1.5">
      {rows.map((d, i) => (
        <li key={d.id} className="flex items-start gap-2.5 text-sm">
          <span className="mt-px shrink-0 font-mono text-xs text-muted-foreground">
            {i + 1}.
          </span>
          <span
            className={
              d.enabled ? 'text-foreground' : 'text-muted-foreground line-through'
            }
          >
            {d.body}
          </span>
          {!d.enabled ? (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              выкл
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

interface KnowledgeRow {
  id: string
  title: string
  enabled: boolean
  preview?: string
}

export function KnowledgePanel({ payload }: { payload: unknown }) {
  const rows = asArray<KnowledgeRow>(payload).filter((r) => r?.id)
  if (rows.length === 0) return <EmptyNote />
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((k) => (
        <li key={k.id} className="text-sm">
          <span
            className={
              k.enabled
                ? 'font-medium'
                : 'font-medium text-muted-foreground line-through'
            }
          >
            {k.title}
          </span>
          {k.preview ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {k.preview}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

interface ScheduleRow {
  id: string
  label: string
  human: string
  enabled: boolean
  lastRunAt: string | null
  lastResult: string | null
}

export function SchedulesPanel({ payload }: { payload: unknown }) {
  const obj = (payload ?? {}) as { schedules?: unknown }
  const rows = asArray<ScheduleRow>(obj.schedules).filter((r) => r?.id)
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Запланированных команд пока нет. Скажите, например: «каждый понедельник
        в 9 присылай отчёт по лидам».
      </p>
    )
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li
          key={r.id}
          className="flex items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5"
        >
          <span
            aria-hidden="true"
            className={
              r.enabled
                ? 'mt-1.5 size-2 shrink-0 rounded-full bg-success'
                : 'mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/50'
            }
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{r.label}</p>
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              {r.human}
              {!r.enabled ? ' · выключено' : ''}
            </p>
            {r.lastResult ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                Последний запуск: {r.lastResult}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
