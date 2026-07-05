'use client'

import { useState, useTransition } from 'react'
import { Loader2, Plus, Power, Target, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  createGoalAction,
  deleteGoalAction,
  updateGoalAction,
} from '@/app/actions/goals'
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
import { cn } from '@/lib/utils'
import type { GoalMessenger, GoalResult } from '@/lib/data'

const MESSENGER_LABEL: Record<GoalMessenger, string> = {
  any: 'Любой мессенджер',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
}

/**
 * Admin panel to manage conversion goals. Goals are definitions that count
 * matching chat → messenger transitions; their completion counts are shown
 * inline and on the manager/admin overviews.
 */
export function GoalsAdmin({ goals }: { goals: GoalResult[] }) {
  const [name, setName] = useState('')
  const [messenger, setMessenger] = useState<GoalMessenger>('any')
  const [pending, startTransition] = useTransition()

  function create() {
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      toast.error('Укажите название цели (минимум 2 символа).')
      return
    }
    startTransition(async () => {
      const res = await createGoalAction({ name: trimmed, messenger })
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setName('')
      setMessenger('any')
    })
  }

  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Target className="size-4" />
        </div>
        <div>
          <h2 className="text-sm font-medium">Конверсионные цели</h2>
          <p className="text-sm text-muted-foreground">
            Цель считает переходы из чата в мессенджер. «Любой мессенджер»
            учитывает все переходы, либо ограничьте цель конкретным каналом.
          </p>
        </div>
      </div>

      {/* Create form */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="goal-name">Название цели</Label>
          <Input
            id="goal-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Напр. Заявка через Telegram"
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:w-52">
          <Label>Событие</Label>
          <Select
            value={messenger}
            onValueChange={(v) => setMessenger((v as GoalMessenger) ?? 'any')}
          >
            <SelectTrigger aria-label="Мессенджер цели">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Любой мессенджер</SelectItem>
              <SelectItem value="telegram">Переход в Telegram</SelectItem>
              <SelectItem value="whatsapp">Переход в WhatsApp</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={create} disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Добавить
        </Button>
      </div>

      {/* Existing goals */}
      {goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Целей пока нет. Создайте первую — она появится в аналитике.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {goals.map((g) => (
            <GoalRow key={g.id} goal={g} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function GoalRow({ goal }: { goal: GoalResult }) {
  const [pending, startTransition] = useTransition()

  function toggle() {
    startTransition(async () => {
      const res = await updateGoalAction(goal.id, { active: !goal.active })
      if (!res.ok) toast.error(res.message)
      else toast.success(res.message)
    })
  }

  function remove() {
    startTransition(async () => {
      const res = await deleteGoalAction(goal.id)
      if (!res.ok) toast.error(res.message)
      else toast.success(res.message)
    })
  }

  return (
    <li className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p
          className={cn(
            'truncate text-sm font-medium',
            !goal.active && 'text-muted-foreground',
          )}
        >
          {goal.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {MESSENGER_LABEL[goal.messenger]} · достижений: {goal.completions}
          {!goal.active ? ' · выключена' : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggle}
          disabled={pending}
          aria-label={goal.active ? 'Выключить цель' : 'Включить цель'}
          title={goal.active ? 'Выключить' : 'Включить'}
        >
          <Power
            className={cn(
              'size-4',
              goal.active ? 'text-success' : 'text-muted-foreground',
            )}
          />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={remove}
          disabled={pending}
          aria-label="Удалить цель"
          title="Удалить"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  )
}
