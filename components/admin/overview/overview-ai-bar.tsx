'use client'

/**
 * ИИ-строка Обзора — админский поисково-командный бар над списком источников.
 *
 * Вопрос на естественном языке прогоняется через каскад уровней 1→3
 * (askOverviewAiAction), а ответ приходит СТРУКТУРНЫМ (summary/table/text/
 * open_source/confirm) — этот компонент рендерит его виджетами, модель НИКОГДА
 * не отдаёт сырой markdown. Мутации источников (переименовать/удалить/создать)
 * возвращаются как kind:'confirm' и исполняются ТОЛЬКО после кнопки «Применить»
 * через confirmOverviewActionAction. Бар живёт лишь на админском /admin (гейт
 * requireAdmin в обоих экшенах).
 */

import { useCallback, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react'
import {
  askOverviewAiAction,
  confirmOverviewActionAction,
} from '@/app/actions/overview-ai'
import { resolvePeriod } from '@/components/admin/overview/period-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type {
  OverviewAiResult,
  OverviewAnswer,
  PendingOverviewAction,
} from '@/lib/ai-overview/types'
import { describePendingAction } from '@/lib/ai-overview/types'
import { cn } from '@/lib/utils'

const SUGGESTIONS = [
  'Сводка за неделю',
  'Худшие источники',
  'Сколько потратили за месяц',
  'Что ты умеешь',
]

/** ResolvedPeriod (Date-границы) → ParsedPeriod (ISO), нужный опциям каскада. */
function fallbackPeriod() {
  const p = resolvePeriod('7d', '', '')
  return { fromISO: p.from.toISOString(), toISO: p.to.toISOString(), label: p.label }
}

function LevelBadge({ level }: { level: 1 | 2 | 3 }) {
  const label = level === 1 ? 'быстрый ответ' : level === 2 ? 'роутер' : 'агент'
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-transparent bg-muted text-[10px] font-normal text-muted-foreground"
    >
      {label}
    </Badge>
  )
}

function MetricsGrid({
  metrics,
}: {
  metrics: { label: string; value: string; sub?: string }[]
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {metrics.map((m, i) => (
        <div key={i} className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {m.label}
          </p>
          <p className="text-lg font-semibold tabular-nums">{m.value}</p>
          {m.sub ? (
            <p className="text-xs text-muted-foreground">{m.sub}</p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function AnswerTableView({
  columns,
  rows,
}: {
  columns: string[]
  rows: (string | number)[][]
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {columns.map((c, i) => (
              <th
                key={i}
                className={cn(
                  'px-3 py-2 text-left font-medium text-muted-foreground',
                  i > 0 && 'text-right',
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border last:border-0">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={cn(
                    'px-3 py-2',
                    ci === 0 ? 'font-medium' : 'text-right tabular-nums',
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
  )
}

function AnswerView({
  answer,
  onOpenSource,
  onConfirm,
  confirming,
  confirmDone,
}: {
  answer: OverviewAnswer
  onOpenSource: (id: string) => void
  onConfirm: (action: PendingOverviewAction) => void
  confirming: boolean
  confirmDone: string | null
}) {
  switch (answer.kind) {
    case 'summary':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">{answer.title}</p>
            <span className="text-xs text-muted-foreground">
              {answer.periodLabel}
            </span>
          </div>
          <MetricsGrid metrics={answer.metrics} />
        </div>
      )
    case 'table':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">{answer.title}</p>
            <span className="text-xs text-muted-foreground">
              {answer.periodLabel}
            </span>
          </div>
          <AnswerTableView
            columns={answer.table.columns}
            rows={answer.table.rows}
          />
        </div>
      )
    case 'open_source':
      return (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">{answer.title}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onOpenSource(answer.sourceId)}
          >
            Открыть источник
            <ArrowRight className="ml-1 size-4" />
          </Button>
        </div>
      )
    case 'text':
      return (
        <div className="flex flex-col gap-1">
          {answer.title ? (
            <p className="text-sm font-semibold">{answer.title}</p>
          ) : null}
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {answer.text}
          </p>
        </div>
      )
    case 'confirm':
      return (
        <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">{answer.title}</p>
            <p className="text-sm text-muted-foreground">
              {answer.description || describePendingAction(answer.action)}
            </p>
          </div>
          {confirmDone ? (
            <p className="flex items-center gap-1.5 text-sm font-medium text-success">
              <Check className="size-4" /> {confirmDone}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => onConfirm(answer.action)}
                disabled={confirming}
              >
                {confirming ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Check className="mr-1 size-4" />
                )}
                Применить
              </Button>
            </div>
          )}
        </div>
      )
  }
}

export function OverviewAiBar({
  onOpenSource,
  onChanged,
}: {
  onOpenSource: (sourceId: string) => void
  onChanged: () => void
}) {
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<OverviewAiResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmDone, setConfirmDone] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const ask = useCallback(async (q: string) => {
    const text = q.trim()
    if (!text) return
    setLoading(true)
    setConfirmDone(null)
    try {
      const res = await askOverviewAiAction(text, {
        fallbackPeriod: fallbackPeriod(),
        tzOffsetMinutes: -new Date().getTimezoneOffset(),
      })
      setResult(res)
    } catch {
      setResult({
        ok: false,
        level: 1,
        message: 'Не удалось обработать запрос. Попробуйте ещё раз.',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  const confirm = useCallback(
    async (action: PendingOverviewAction) => {
      setConfirming(true)
      try {
        const res = await confirmOverviewActionAction(action)
        if (res.ok) {
          setConfirmDone(res.message)
          onChanged()
        } else {
          setResult({ ok: false, level: 1, message: res.message })
        }
      } catch {
        setResult({
          ok: false,
          level: 1,
          message: 'Не удалось выполнить действие.',
        })
      } finally {
        setConfirming(false)
      }
    },
    [onChanged],
  )

  return (
    <Card className="flex flex-col gap-3 p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void ask(question)
        }}
        className="flex items-center gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <Sparkles className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-primary" />
          <Input
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault()
                void ask(question)
              }
            }}
            placeholder="Спросите об источниках или дайте команду…"
            className="h-9 pl-8"
            aria-label="Вопрос ИИ-строке Обзора"
          />
        </div>
        <Button type="submit" size="sm" disabled={loading || !question.trim()}>
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            'Спросить'
          )}
        </Button>
      </form>

      {!result && !loading ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setQuestion(s)
                void ask(s)
              }}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {result.ok && result.answer ? (
                <AnswerView
                  answer={result.answer}
                  onOpenSource={onOpenSource}
                  onConfirm={confirm}
                  confirming={confirming}
                  confirmDone={confirmDone}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {result.message ?? 'Пустой ответ.'}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <LevelBadge level={result.level} />
              <button
                type="button"
                onClick={() => {
                  setResult(null)
                  setConfirmDone(null)
                  inputRef.current?.focus()
                }}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Закрыть ответ"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
