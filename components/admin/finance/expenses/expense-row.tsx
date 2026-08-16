'use client'

import { useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import {
  addTaskAction,
  deleteTaskAction,
  toggleTaskAction,
  type FinanceResult,
} from '@/app/actions/finance'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { FinanceCurrency, FinanceEntry } from '@/lib/finance-types'
import {
  STATUS_META,
  formatDate,
  formatMoney,
  formatUsd,
} from '@/components/admin/finance/finance-utils'

/** One expandable expense row: summary cells plus inline notes + task checklist. */
export function ExpenseRow({
  entry,
  isOpen,
  doneTasks,
  pending,
  onToggle,
  onEdit,
  onDelete,
  run,
}: {
  entry: FinanceEntry
  currency: FinanceCurrency
  isOpen: boolean
  doneTasks: number
  pending: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  run: (fn: () => Promise<FinanceResult>, onOk?: () => void) => void
}) {
  const [taskInput, setTaskInput] = useState('')
  const total = entry.tasks.length
  const progress = total > 0 ? Math.round((doneTasks / total) * 100) : 0

  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-muted/30">
        <td className="px-3 py-2.5 align-top">
          <button
            type="button"
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Раскрыть детали"
          >
            {isOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        </td>
        <td className="px-3 py-2.5 align-top">
          <div className="font-medium">{entry.title}</div>
          {total > 0 ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              Задачи: {doneTasks}/{total}
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2.5 align-top text-muted-foreground">
          {entry.vendor || '—'}
        </td>
        <td className="px-3 py-2.5 align-top">
          <Badge
            variant="outline"
            className={cn('font-medium', STATUS_META[entry.status].className)}
          >
            {STATUS_META[entry.status].label}
          </Badge>
        </td>
        <td className="px-3 py-2.5 align-top whitespace-nowrap text-muted-foreground">
          {formatDate(entry.entryDate)}
          {entry.dueDate ? (
            <div className="text-xs">до {formatDate(entry.dueDate)}</div>
          ) : null}
        </td>
        <td className="px-3 py-2.5 align-top text-right font-semibold tabular-nums">
          {formatUsd(entry.amount)}
          {entry.origCurrency !== 'USD' && entry.origCurrency !== 'USDT' ? (
            <div className="text-xs font-normal text-muted-foreground">
              {formatMoney(entry.origAmount, entry.origCurrency)}
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2.5 align-top">
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={onEdit}
              aria-label="Изменить"
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-destructive hover:text-destructive"
              onClick={onDelete}
              aria-label="Удалить"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-border bg-muted/20">
          <td />
          <td colSpan={6} className="px-3 py-3">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Заметки / ответы
                </h4>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {entry.notes || 'Нет заметок.'}
                </p>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Чек-лист задач
                  </h4>
                  {total > 0 ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {doneTasks}/{total} · {progress}%
                    </span>
                  ) : null}
                </div>
                {total > 0 ? (
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-success transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                ) : null}
                <ul className="space-y-1">
                  {entry.tasks.map((t) => (
                    <li key={t.id} className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(() => toggleTaskAction(t.id, !t.done))
                        }
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded border',
                          t.done
                            ? 'border-success bg-success text-success-foreground'
                            : 'border-input',
                        )}
                        aria-label={t.done ? 'Снять отметку' : 'Отметить выполненным'}
                      >
                        {t.done ? <Check className="size-3" /> : null}
                      </button>
                      <span
                        className={cn(
                          'flex-1 text-sm',
                          t.done && 'text-muted-foreground line-through',
                        )}
                      >
                        {t.label}
                      </span>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => deleteTaskAction(t.id))}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="Удалить пункт"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                <form
                  className="mt-2 flex items-center gap-1.5"
                  onSubmit={(ev) => {
                    ev.preventDefault()
                    const label = taskInput.trim()
                    if (!label) return
                    run(
                      () => addTaskAction(entry.id, label),
                      () => setTaskInput(''),
                    )
                  }}
                >
                  <Input
                    value={taskInput}
                    onChange={(ev) => setTaskInput(ev.target.value)}
                    placeholder="Новый пункт…"
                    className="h-8"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={pending || !taskInput.trim()}
                  >
                    <Plus className="size-4" />
                  </Button>
                </form>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}
