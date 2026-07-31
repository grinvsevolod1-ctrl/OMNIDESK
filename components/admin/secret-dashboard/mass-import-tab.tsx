'use client'

/**
 * Mass-import tab for the secret dashboard: bulk-generate conversations across
 * channels with a time spread, plus the reversible 'hide names (NULL)' glitch
 * toggle. Extracted from the secret-dashboard monolith; props-driven (channels
 * + a shared `run` action dispatcher), owning only its local form state.
 */

import { useMemo, useState } from 'react'
import {
  CheckCircle2,
  Eraser,
  Loader2,
  BrainCircuit,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import {
  secretBulkCreateConversationsAction,
  secretSetNamesHiddenAction,
  type ActionResult,
} from '@/app/actions/admin-secret'
import { ChannelIcon } from '@/components/channel-icons'
import { EmptyState } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { Channel } from '@/lib/types'

const HOUR_PRESETS: { label: string; hours: number }[] = [
  { label: '1ч', hours: 1 },
  { label: '6ч', hours: 6 },
  { label: '24ч', hours: 24 },
  { label: '7д', hours: 168 },
  { label: '30д', hours: 720 },
]

const COUNT_PRESETS = [10, 25, 50, 100]

/** Human-readable RU label for a span given in hours. */
function formatHours(hours: number): string {
  if (hours <= 0) return 'текущий момент'
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`
  const days = Math.round((hours / 24) * 10) / 10
  const whole = Number.isInteger(days) ? days : Math.round(days)
  return `${whole} ${plural(whole, 'день', 'дня', 'дней')}`
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

export function MassImportTab({
  channels,
  managerName,
  pending,
  run,
  namesHidden,
}: {
  channels: Channel[]
  managerName: (id: string | null) => string
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
  namesHidden: boolean
}) {
  // Only channels with an owner can host a conversation.
  const eligible = useMemo(() => channels.filter((c) => c.managerId), [channels])

  const [count, setCount] = useState(10)
  const [spreadHours, setSpreadHours] = useState(24)
  const [withMessage, setWithMessage] = useState(true)
  const [markUnread, setMarkUnread] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(eligible.map((c) => c.id)),
  )

  const selectedIds = eligible.filter((c) => selected.has(c.id)).map((c) => c.id)
  const canGenerate = count > 0 && selectedIds.length > 0 && !pending

  function toggleChannel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function generate() {
    run(() =>
      secretBulkCreateConversationsAction({
        count,
        channelIds: selectedIds,
        spreadHours,
        withMessage,
        markUnread,
      }),
    )
  }

  if (eligible.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="Нет каналов с владельцем"
        description="Сначала создайте канал и назначьте ему менеджера — тогда можно массово наливать диалоги."
      />
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      {/* ---- Config ---- */}
      <Card className="flex flex-col gap-6 p-5">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40">
            <BrainCircuit className="size-5 text-foreground" />
          </div>
          <div>
            <h3 className="font-semibold tracking-tight">Массовое создание диалогов</h3>
            <p className="text-sm text-muted-foreground text-pretty">
              Сгенерируйте пачку диалогов с разных каналов и с разным временем —
              как внезапный наплыв обращений.
            </p>
          </div>
        </div>

        {/* Count */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-count">Сколько диалогов</Label>
          <div className="flex flex-wrap items-center gap-2">
            {COUNT_PRESETS.map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={count === p ? 'default' : 'outline'}
                className="press-scale"
                onClick={() => setCount(p)}
              >
                {p}
              </Button>
            ))}
            <Input
              id="bulk-count"
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) =>
                setCount(Math.min(Math.max(Number(e.target.value) || 0, 1), 100))
              }
              className="w-24"
            />
            <span className="text-xs text-muted-foreground">макс. 100 за раз</span>
          </div>
        </div>

        {/* Time window */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-hours">Разброс по времени (часов)</Label>
          <div className="flex flex-wrap items-center gap-2">
            {HOUR_PRESETS.map((h) => (
              <Button
                key={h.hours}
                type="button"
                size="sm"
                variant={spreadHours === h.hours ? 'default' : 'outline'}
                className="press-scale"
                onClick={() => setSpreadHours(h.hours)}
              >
                {h.label}
              </Button>
            ))}
            <Input
              id="bulk-hours"
              type="number"
              min={0}
              max={2160}
              value={spreadHours}
              onChange={(e) =>
                setSpreadHours(Math.min(Math.max(Number(e.target.value) || 0, 0), 2160))
              }
              className="w-24"
            />
            <span className="text-xs text-muted-foreground">макс. 2160 ч (90 дней)</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Время последнего сообщения распределится случайно за последние{' '}
            {formatHours(spreadHours)}.
          </p>
        </div>

        {/* Options */}
        <div className="flex flex-col gap-2">
          <Label>Параметры</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            <ToggleTile
              active={withMessage}
              onClick={() => setWithMessage((v) => !v)}
              title="С первым сообщением"
              description="Добавить входящее сообщение от клиента"
            />
            <ToggleTile
              active={markUnread}
              onClick={() => setMarkUnread((v) => !v)}
              disabled={!withMessage}
              title="Отметить непрочитанным"
              description="Поднять счётчик непрочитанных у менеджера"
            />
          </div>
        </div>

        {/* Channels */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label>Каналы-источники</Label>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                className="text-foreground/70 underline-offset-2 hover:underline"
                onClick={() => setSelected(new Set(eligible.map((c) => c.id)))}
              >
                Все
              </button>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                className="text-foreground/70 underline-offset-2 hover:underline"
                onClick={() => setSelected(new Set())}
              >
                Сброс
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {eligible.map((c) => {
              const on = selected.has(c.id)
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleChannel(c.id)}
                  className={cn(
                    'press-scale inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    on
                      ? 'border-foreground/20 bg-foreground text-background'
                      : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
                  )}
                >
                  <ChannelIcon type={c.type} className="size-3.5" />
                  {c.name}
                </button>
              )
            })}
          </div>
        </div>
      </Card>

      {/* ---- Summary / action ---- */}
      <Card className="flex flex-col gap-5 p-5">
        <h3 className="font-semibold tracking-tight">Итог</h3>
        <div className="flex flex-col gap-3 text-sm">
          <SummaryRow label="Диалогов" value={String(count)} />
          <SummaryRow
            label="Каналов выбрано"
            value={`${selectedIds.length} из ${eligible.length}`}
          />
          <SummaryRow label="Окно времени" value={formatHours(spreadHours)} />
          <SummaryRow label="Сообщение" value={withMessage ? 'да' : 'нет'} />
          <SummaryRow
            label="Непрочитанные"
            value={withMessage && markUnread ? 'да' : 'нет'}
          />
        </div>

        {selectedIds.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Владельцы:{' '}
            {Array.from(
              new Set(
                eligible
                  .filter((c) => selected.has(c.id))
                  .map((c) => managerName(c.managerId)),
              ),
            ).join(', ')}
          </div>
        )}

        <Button
          size="lg"
          className="press-scale mt-auto gap-2"
          disabled={!canGenerate}
          onClick={generate}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Zap className="size-4" />
          )}
          Создать {count}{' '}
          {count % 10 === 1 && count % 100 !== 11 ? 'диалог' : 'диалогов'}
        </Button>
        {selectedIds.length === 0 && (
          <p className="text-center text-xs text-destructive">
            Выберите хотя бы один канал
          </p>
        )}
      </Card>

      {/* ---- Reversible "names glitch" toggle ---- */}
      <Card
        className={cn(
          'flex flex-col gap-4 p-5 transition-colors lg:col-span-2',
          namesHidden ? 'border-destructive/40 bg-destructive/5' : '',
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-xl border',
                namesHidden
                  ? 'border-destructive/30 bg-destructive/10'
                  : 'border-border bg-muted/40',
              )}
            >
              {namesHidden ? (
                <TriangleAlert className="size-5 text-destructive" />
              ) : (
                <Eraser className="size-5 text-foreground" />
              )}
            </div>
            <div>
              <h3 className="font-semibold tracking-tight">Скрыть имена (NULL)</h3>
              <p className="text-sm text-muted-foreground text-pretty">
                Показывает «NULL» вместо имени во всех диалогах — имитация сбоя
                базы. Обратимо: реальные имена сохранены и вернутся при выключении.
              </p>
              <p className="mt-1 text-xs font-medium">
                {namesHidden ? (
                  <span className="text-destructive">
                    Сейчас имена скрыты во всех диалогах
                  </span>
                ) : (
                  <span className="text-muted-foreground">Имена отображаются нормально</span>
                )}
              </p>
            </div>
          </div>
          <Button
            variant={namesHidden ? 'default' : 'outline'}
            className="press-scale shrink-0 gap-2"
            disabled={pending}
            onClick={() => run(() => secretSetNamesHiddenAction(!namesHidden))}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Eraser className="size-4" />
            )}
            {namesHidden ? 'Вернуть имена' : 'Скрыть имена'}
          </Button>
        </div>
      </Card>
    </div>
  )
}

function ToggleTile({
  active,
  onClick,
  title,
  description,
  disabled,
}: {
  active: boolean
  onClick: () => void
  title: string
  description: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'press-scale flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-foreground/20 bg-muted/50'
          : 'border-border bg-transparent hover:bg-muted/30',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors',
          active ? 'border-foreground bg-foreground text-background' : 'border-border',
        )}
      >
        {active && <CheckCircle2 className="size-3.5" />}
      </div>
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground text-pretty">{description}</div>
      </div>
    </button>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  )
}
