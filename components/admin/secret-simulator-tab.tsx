'use client'

import { useCallback, useRef, useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  Bot,
  CalendarClock,
  CircleDot,
  Gauge,
  Loader2,
  Minus,
  MessageCircle,
  Plus,
  Power,
  TriangleAlert,
  Users2,
} from 'lucide-react'
import { ChannelIcon } from '@/components/channel-icons'
import { SecretSimulatorAdopt } from '@/components/admin/secret-simulator-adopt'
import { SecretSimulatorCampaign } from '@/components/admin/secret-simulator-campaign'
import { SecretSimulatorLearn } from '@/components/admin/secret-simulator-learn'
import { SecretSimulatorLogs } from '@/components/admin/secret-simulator-logs'
import { SecretSimulatorTest } from '@/components/admin/secret-simulator-test'
import {
  simStatusAction,
  simToggleAction,
  simUpdateSettingsAction,
} from '@/app/actions/client-sim'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { Channel } from '@/lib/types'
import type { SimStatus } from '@/lib/client-sim/types'

const STATE_LABEL: Record<string, string> = {
  opening: 'Открывают',
  chatting: 'Переписка',
  ignoring: 'Молчат',
  later: 'Ответят позже',
  sleeping: 'Спят / ночь',
  vanished: 'Пропали',
  done: 'Завершено',
}

const STATE_ORDER = [
  'opening',
  'chatting',
  'ignoring',
  'later',
  'sleeping',
  'vanished',
  'done',
] as const

const OUTCOME_LABEL: Record<string, string> = {
  ended: 'Договорили',
  left: 'Ушли (потеряли интерес)',
  competitor: 'Ушли к конкуренту',
  ghosted: 'Пропали навсегда',
  angry: 'Вспылили',
}

const OUTCOME_ORDER = ['ended', 'left', 'competitor', 'ghosted', 'angry'] as const

const MIN_PER_DAY = 1
const MAX_PER_DAY = 5000
const MIN_CONCURRENT = 1
const MAX_CONCURRENT = 1000

/** Human-friendly seconds → "45с" / "3м" / "2ч". */
function humanGap(total: number): string {
  const s = Math.max(0, Math.round(total))
  if (s < 60) return `${s} сек`
  if (s < 3600) return `${Math.round(s / 60)} мин`
  const h = s / 3600
  return h < 10 ? `${h.toFixed(1)} ч` : `${Math.round(h)} ч`
}

/** Explain the real-world cadence a per-day target implies. */
function perDayHint(perDay: number): string {
  const clamped = Math.min(Math.max(perDay, MIN_PER_DAY), MAX_PER_DAY)
  const avgGap = 86_400 / clamped
  return `≈ новый диалог в среднем раз в ${humanGap(avgGap)}, вразнобой и круглосуточно`
}

export function SecretSimulatorTab({ channels }: { channels: Channel[] }) {
  const eligible = channels.filter((c) => c.managerId)

  const [pending, startTransition] = useTransition()

  // The single tunable + channel selection. Synced from the server snapshot on
  // first load and after saves.
  const [perDay, setPerDay] = useState(20)
  const [maxConcurrent, setMaxConcurrent] = useState(100)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const hydrated = useRef(false)

  const hydrateControls = useCallback((s: SimStatus) => {
    setPerDay(s.dialogsPerDay)
    setMaxConcurrent(s.maxConcurrent)
    setSelected(new Set(s.channelIds))
  }, [])

  const {
    data: status = null,
    error,
    mutate: mutateStatus,
  } = useSWR<SimStatus>('sim-status', () => simStatusAction(), {
    refreshInterval: 6_000,
    revalidateOnFocus: false,
    onSuccess: (s) => {
      if (!hydrated.current) {
        hydrateControls(s)
        hydrated.current = true
      }
    },
  })
  const loadError = Boolean(error)
  const running = status?.enabled ?? false

  function toggle(next: boolean) {
    startTransition(async () => {
      try {
        const s = await simToggleAction(next)
        void mutateStatus(s, { revalidate: false })
        toast.success(next ? 'Симулятор запущен' : 'Симулятор остановлен')
      } catch {
        toast.error('Не удалось переключить симулятор')
      }
    })
  }

  function save() {
    const dialogsPerDay = Math.min(Math.max(Math.round(perDay) || MIN_PER_DAY, MIN_PER_DAY), MAX_PER_DAY)
    const maxCc = Math.min(
      Math.max(Math.round(maxConcurrent) || MIN_CONCURRENT, MIN_CONCURRENT),
      MAX_CONCURRENT,
    )
    startTransition(async () => {
      try {
        const s = await simUpdateSettingsAction({
          dialogsPerDay,
          maxConcurrent: maxCc,
          channelIds: Array.from(selected),
        })
        void mutateStatus(s, { revalidate: false })
        setPerDay(s.dialogsPerDay)
        setMaxConcurrent(s.maxConcurrent)
        toast.success('Настройки сохранены')
      } catch {
        toast.error('Не удалось сохранить настройки')
      }
    })
  }

  function bumpPerDay(delta: number) {
    setPerDay((v) => Math.min(Math.max((Math.round(v) || 0) + delta, MIN_PER_DAY), MAX_PER_DAY))
  }

  function bumpConcurrent(delta: number) {
    setMaxConcurrent((v) =>
      Math.min(Math.max((Math.round(v) || 0) + delta, MIN_CONCURRENT), MAX_CONCURRENT),
    )
  }

  function toggleChannel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const noChannelsChosen = selected.size === 0

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Master control ---- */}
      <Card
        className={cn(
          'flex flex-col gap-4 p-5 transition-colors',
          running && 'border-success/40 bg-success/5',
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-xl border',
                running
                  ? 'border-success/40 bg-success/15 text-success'
                  : 'border-border bg-muted/40 text-foreground',
              )}
            >
              <Bot className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold tracking-tight">Симулятор клиентов</h3>
                {running ? (
                  <Badge className="gap-1 bg-success/15 text-success">
                    <CircleDot className="size-3 animate-pulse" />
                    Работает
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1">
                    <Power className="size-3" />
                    Выключен
                  </Badge>
                )}
              </div>
              <p className="max-w-prose text-sm text-muted-foreground text-pretty">
                Живые ИИ-клиенты сами пишут менеджерам по выбранным каналам,
                торгуются, ругаются, тупят и по-разному реагируют на предложения.
                Каждый «клиент» уникален — тон, характер и манера свои, никто не
                повторяется. Работает в фоне даже с закрытой панелью.
              </p>
            </div>
          </div>
          <Switch
            checked={running}
            onCheckedChange={(v) => toggle(Boolean(v))}
            disabled={pending || (!running && noChannelsChosen)}
            aria-label="Включить симулятор"
          />
        </div>

        {!running && noChannelsChosen && (
          <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            <TriangleAlert className="size-4 shrink-0" />
            Выберите хотя бы один канал ниже, затем сохраните — и можно запускать.
          </div>
        )}

        {status && !status.aiConfigured && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <TriangleAlert className="size-4 shrink-0" />
            ИИ-генерация недоступна (нет ключа AI Gateway) — используются
            встроенные шаблоны с рандомизацией.
          </div>
        )}

        {loadError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <TriangleAlert className="size-4 shrink-0" />
            Не удалось получить статус симулятора.
          </div>
        )}
      </Card>

      {/* ---- Live counters ---- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MiniStat
          icon={Users2}
          label="Активные диалоги"
          value={`${status?.activeThreads ?? 0} / ${status?.maxConcurrent ?? maxConcurrent}`}
        />
        <MiniStat
          icon={MessageCircle}
          label="Ответов всего"
          value={status?.repliesTotal ?? 0}
        />
        <MiniStat
          icon={Bot}
          label="Создано диалогов"
          value={status?.spawnedTotal ?? 0}
        />
        <MiniStat
          icon={CalendarClock}
          label="Диалогов в сутки"
          value={status?.dialogsPerDay ?? perDay}
        />
      </div>

      {/* ---- Campaign scheduler (N dialogues over H hours) ---- */}
      <SecretSimulatorCampaign
        status={status}
        onChanged={(s) => void mutateStatus(s, { revalidate: false })}
      />

      {/* ---- Lifecycle state breakdown ---- */}
      {status && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap gap-2">
            {STATE_ORDER.map((st) => (
              <div
                key={st}
                className="flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-xs"
              >
                <span className="text-muted-foreground">{STATE_LABEL[st]}</span>
                <span className="font-semibold tabular-nums">
                  {status.byState[st] ?? 0}
                </span>
              </div>
            ))}
          </div>
          {/* Fates of finished dialogues */}
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <span className="text-xs text-muted-foreground">Как завершились:</span>
            {OUTCOME_ORDER.map((oc) => (
              <div
                key={oc}
                className="flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-xs"
              >
                <span className="text-muted-foreground">{OUTCOME_LABEL[oc]}</span>
                <span className="font-semibold tabular-nums">
                  {status.byOutcome[oc] ?? 0}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ---- Learn from real dialogues ---- */}
      <SecretSimulatorLearn
        key={status?.learnedProfile?.learnedAt ?? 'none'}
        initial={status?.learnedProfile ?? null}
      />

      {/* ---- The single knob + channels ---- */}
      <Card className="flex flex-col gap-6 p-5">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" />
          <h3 className="font-semibold tracking-tight">Настройки</h3>
        </div>

        {/* Dialogues per day */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="sim-per-day">Диалогов в сутки</Label>
            <span className="text-xs text-muted-foreground">{perDayHint(perDay)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-10 shrink-0"
              onClick={() => bumpPerDay(-1)}
              disabled={perDay <= MIN_PER_DAY}
              aria-label="Меньше"
            >
              <Minus className="size-4" />
            </Button>
            <Input
              id="sim-per-day"
              type="number"
              inputMode="numeric"
              min={MIN_PER_DAY}
              max={MAX_PER_DAY}
              value={perDay}
              onChange={(e) => setPerDay(Number(e.target.value))}
              onBlur={() =>
                setPerDay((v) =>
                  Math.min(Math.max(Math.round(v) || MIN_PER_DAY, MIN_PER_DAY), MAX_PER_DAY),
                )
              }
              className="h-10 max-w-32 text-center text-base font-semibold tabular-nums"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-10 shrink-0"
              onClick={() => bumpPerDay(1)}
              disabled={perDay >= MAX_PER_DAY}
              aria-label="Больше"
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground text-pretty">
            Темп прихода новых. Скорость ответов, тон и характер симулятор
            подбирает сам, чтобы поведение было живым и непредсказуемым.
          </p>
        </div>

        {/* Max concurrent dialogues — independent of daily throughput */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="sim-max-cc">Одновременных диалогов (лимит)</Label>
            <span className="text-xs text-muted-foreground">
              до {MAX_CONCURRENT}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-10 shrink-0"
              onClick={() => bumpConcurrent(-5)}
              disabled={maxConcurrent <= MIN_CONCURRENT}
              aria-label="Меньше"
            >
              <Minus className="size-4" />
            </Button>
            <Input
              id="sim-max-cc"
              type="number"
              inputMode="numeric"
              min={MIN_CONCURRENT}
              max={MAX_CONCURRENT}
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(Number(e.target.value))}
              onBlur={() =>
                setMaxConcurrent((v) =>
                  Math.min(
                    Math.max(Math.round(v) || MIN_CONCURRENT, MIN_CONCURRENT),
                    MAX_CONCURRENT,
                  ),
                )
              }
              className="h-10 max-w-32 text-center text-base font-semibold tabular-nums"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-10 shrink-0"
              onClick={() => bumpConcurrent(5)}
              disabled={maxConcurrent >= MAX_CONCURRENT}
              aria-label="Больше"
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground text-pretty">
            Сколько «живых» клиентов может вести переписку одновременно —
            независимо от суточного потока. Сюда входят и те, кто сейчас спит,
            обещал ответить позже или временно пропал: они занимают место, но не
            пишут постоянно. Можно смело ставить до 100.
          </p>
        </div>

        {/* Channels */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label>Каналы для симуляции</Label>
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
          {eligible.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              Нет каналов с назначенным менеджером. Создайте канал и назначьте
              владельца во вкладке «Каналы».
            </p>
          ) : (
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
          )}
        </div>

        <Button
          size="lg"
          className="press-scale gap-2 self-start"
          onClick={save}
          disabled={pending}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Gauge className="size-4" />
          )}
          Сохранить настройки
        </Button>
      </Card>

      {/* ---- Continue existing / real dialogues ---- */}
      <SecretSimulatorAdopt />

      {/* ---- Live activity log (simulator-only, god-panel isolated) ---- */}
      <SecretSimulatorLogs />

      {/* ---- Interactive test sandbox ---- */}
      <SecretSimulatorTest />
    </div>
  )
}

/* ------------------------------- pieces --------------------------------- */

function MiniStat({
  icon: Icon,
  label,
  value,
  small,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | number
  small?: boolean
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
        <Icon className="size-4 text-foreground" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className={cn('font-semibold tabular-nums', small ? 'text-sm' : 'text-lg')}>
          {value}
        </p>
      </div>
    </Card>
  )
}
