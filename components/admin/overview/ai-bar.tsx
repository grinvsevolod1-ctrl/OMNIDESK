'use client'

/**
 * ИИ-строка Обзора: спросить о источниках/лидах/деньгах своими словами.
 *
 * Уровень 0 живёт прямо здесь (0 токенов, 0 запросов): если текст — просто
 * имя источника, карточка открывается мгновенно без сервера. Всё остальное
 * уходит в askOverviewAiAction (каскад 1→2→3). Ответы — структурные виджеты,
 * мутации применяются только после явного подтверждения кнопкой.
 */

import { Loader2, Sparkles, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { askOverviewAiAction, confirmOverviewActionAction } from '@/app/actions/overview-ai'
import { Button } from '@/components/ui/button'
import {
  classifyOverviewQuery,
  matchSourceName,
  type ParsedPeriod,
} from '@/lib/ai-overview/intents'
import type { OverviewAnswer, PendingOverviewAction } from '@/lib/ai-overview/types'
import { cn } from '@/lib/utils'

type BarState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'answer'; answer: OverviewAnswer; level: 1 | 2 | 3 }
  | { phase: 'error'; message: string }
  | { phase: 'applied'; message: string }

export function AiBar({
  sources,
  fallbackPeriod,
  onOpenSource,
  onDataChanged,
}: {
  sources: { id: string; name: string }[]
  fallbackPeriod: ParsedPeriod
  onOpenSource: (id: string) => void
  onDataChanged: () => void
}) {
  const [value, setValue] = useState('')
  const [state, setState] = useState<BarState>({ phase: 'idle' })
  const [applying, setApplying] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function ask() {
    const q = value.trim()
    if (!q || state.phase === 'loading') return

    // Уровень 0: чистое имя источника — открываем карточку без сервера.
    const cls = classifyOverviewQuery(q)
    const matched = matchSourceName(q, sources)
    if (matched && cls.intent === 'unknown' && q.length <= 40) {
      onOpenSource(matched.id)
      setValue('')
      setState({ phase: 'idle' })
      return
    }

    setState({ phase: 'loading' })
    const res = await askOverviewAiAction(q, {
      fallbackPeriod,
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    })
    if (!res.ok || !res.answer) {
      setState({ phase: 'error', message: res.message ?? 'Что-то пошло не так.' })
      return
    }
    if (res.answer.kind === 'open_source') {
      onOpenSource(res.answer.sourceId)
      setValue('')
      setState({ phase: 'idle' })
      return
    }
    setState({ phase: 'answer', answer: res.answer, level: res.level })
  }

  async function applyAction(action: PendingOverviewAction) {
    setApplying(true)
    const res = await confirmOverviewActionAction(action)
    setApplying(false)
    setState(
      res.ok
        ? { phase: 'applied', message: res.message }
        : { phase: 'error', message: res.message },
    )
    if (res.ok) {
      setValue('')
      onDataChanged()
    }
  }

  const showPanel = state.phase !== 'idle' && state.phase !== 'loading'

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Sparkles
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-primary"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault()
              void ask()
            }
            if (e.key === 'Escape') setState({ phase: 'idle' })
          }}
          placeholder="Спросите: «как дела за неделю», «топ источников», «сколько потратили»…"
          aria-label="Вопрос к ИИ по источникам"
          className={cn(
            'h-11 w-full rounded-xl border border-border bg-card pl-10 pr-24 text-sm',
            'placeholder:text-muted-foreground/70',
            'focus:outline-none focus:ring-2 focus:ring-primary/40',
          )}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2">
          <Button
            size="sm"
            onClick={() => void ask()}
            disabled={!value.trim() || state.phase === 'loading'}
            className="h-7 rounded-lg px-3 text-xs"
          >
            {state.phase === 'loading' ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              'Спросить'
            )}
          </Button>
        </div>
      </div>

      {showPanel && (
        <div
          role="status"
          className="relative rounded-xl border border-border bg-card p-4"
        >
          <button
            type="button"
            onClick={() => setState({ phase: 'idle' })}
            aria-label="Закрыть ответ"
            className="absolute right-2.5 top-2.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>

          {state.phase === 'error' && (
            <p className="pr-8 text-sm text-destructive">{state.message}</p>
          )}

          {state.phase === 'applied' && (
            <p className="pr-8 text-sm text-foreground">{state.message}</p>
          )}

          {state.phase === 'answer' && (
            <AnswerView
              answer={state.answer}
              applying={applying}
              onApply={(a) => void applyAction(a)}
              onCancel={() => setState({ phase: 'idle' })}
            />
          )}
        </div>
      )}
    </div>
  )
}

function AnswerView({
  answer,
  applying,
  onApply,
  onCancel,
}: {
  answer: OverviewAnswer
  applying: boolean
  onApply: (a: PendingOverviewAction) => void
  onCancel: () => void
}) {
  switch (answer.kind) {
    case 'summary':
      return (
        <div className="flex flex-col gap-3 pr-8">
          <p className="text-sm font-medium">
            {answer.title}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {answer.periodLabel}
            </span>
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {answer.metrics.map((m) => (
              <div key={m.label} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{m.label}</span>
                <span className="text-lg font-semibold tabular-nums">{m.value}</span>
                {m.sub && (
                  <span className="text-xs text-muted-foreground">{m.sub}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )
    case 'table':
      return (
        <div className="flex flex-col gap-3 pr-8">
          <p className="text-sm font-medium">
            {answer.title}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {answer.periodLabel}
            </span>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  {answer.table.columns.map((c) => (
                    <th
                      key={c}
                      scope="col"
                      className="pb-2 pr-4 text-xs font-medium text-muted-foreground"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {answer.table.rows.map((row, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-0">
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className={cn(
                          'py-1.5 pr-4',
                          j === 0 ? 'font-medium' : 'tabular-nums text-muted-foreground',
                        )}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )
    case 'text':
      return (
        <div className="flex flex-col gap-1.5 pr-8">
          {answer.title && <p className="text-sm font-medium">{answer.title}</p>}
          <p className="whitespace-pre-line text-sm text-muted-foreground">
            {answer.text}
          </p>
        </div>
      )
    case 'confirm':
      return (
        <div className="flex flex-col gap-3 pr-8">
          <p className="text-sm font-medium">{answer.title}</p>
          <p className="text-sm text-muted-foreground">{answer.description}</p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => onApply(answer.action)}
              disabled={applying}
              className="h-8"
            >
              {applying ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                'Применить'
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              disabled={applying}
              className="h-8"
            >
              Отмена
            </Button>
          </div>
        </div>
      )
    default:
      return null
  }
}
