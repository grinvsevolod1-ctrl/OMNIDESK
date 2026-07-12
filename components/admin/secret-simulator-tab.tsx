'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Bot,
  CircleDot,
  Flame,
  Gauge,
  Loader2,
  MessageCircle,
  Power,
  Timer,
  TriangleAlert,
  Users2,
} from 'lucide-react'
import { ChannelIcon } from '@/components/channel-icons'
import { SecretSimulatorLearn } from '@/components/admin/secret-simulator-learn'
import { SecretSimulatorTest } from '@/components/admin/secret-simulator-test'
import {
  simStatusAction,
  simToggleAction,
  simUpdateSettingsAction,
} from '@/app/actions/client-sim'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { Channel } from '@/lib/types'
import type { SimStatus, SimTone } from '@/lib/client-sim/types'

const TONE_OPTIONS: Array<{ value: SimTone; label: string; hint: string }> = [
  { value: 'polite', label: 'Вежливый', hint: '«Здравствуйте», на «вы», грамотно, без мата' },
  { value: 'neutral', label: 'Обычный', hint: 'Спокойный разговорный тон, по-человечески' },
  { value: 'rough', label: 'Грубый', hint: 'Развязно, панибратски, мат по настроению' },
  { value: 'mixed', label: 'Разный', hint: 'Случайный разброс — от вежливых до грубых' },
]

function toneLabel(t: SimTone): string {
  return TONE_OPTIONS.find((o) => o.value === t)?.label ?? 'Разный'
}

const STATE_LABEL: Record<string, string> = {
  opening: 'Открывают',
  chatting: 'Переписка',
  ignoring: 'Игнорят',
  done: 'Завершено',
}

function aggressionLabel(v: number): string {
  if (v < 20) return 'Спокойный'
  if (v < 45) return 'Обычный'
  if (v < 70) return 'Дерзкий'
  if (v < 90) return 'Агрессивный'
  return 'Токсичный'
}

/**
 * Convert a "conversations per hour" target into jittered second bounds. The
 * window is deliberately wide (0.5×–1.6× the average gap) so spawns land at
 * irregular, human-looking intervals instead of on a fixed clock. The average
 * of that window stays close to the requested rate.
 */
function perHourToRange(rate: number): { min: number; max: number } {
  const r = Math.min(Math.max(rate, 1), 60)
  const avg = 3600 / r
  return { min: Math.round(avg * 0.5), max: Math.round(avg * 1.6) }
}

/** Inverse of perHourToRange — recover the approximate per-hour rate. */
function rangeToPerHour(minSec: number, maxSec: number): number {
  const avg = (minSec + maxSec) / 2
  if (avg <= 0) return 10
  return Math.min(Math.max(Math.round(3600 / avg), 1), 60)
}

/** Human-friendly seconds → "45с" / "3м" / "2м 30с". */
function humanSecs(total: number): string {
  const s = Math.max(0, Math.round(total))
  if (s < 60) return `${s}с`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem === 0 ? `${m}м` : `${m}м ${rem}с`
}

/** Sub-label under the rate slider explaining the real-world cadence. */
function perHourHint(rate: number): string {
  const avgGap = Math.round(3600 / Math.min(Math.max(rate, 1), 60))
  return `≈ 1 диалог в ${humanSecs(avgGap)}, вразнобой`
}

export function SecretSimulatorTab({ channels }: { channels: Channel[] }) {
  const eligible = channels.filter((c) => c.managerId)

  const [status, setStatus] = useState<SimStatus | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [pending, startTransition] = useTransition()

  // Local, editable copies of the tunables (so sliders feel instant); synced
  // from the server snapshot on first load and after saves.
  const [aggression, setAggression] = useState(60)
  const [tone, setTone] = useState<SimTone>('mixed')
  const [maxThreads, setMaxThreads] = useState(6)
  // "New conversations per hour" is the human-facing control; it's converted
  // to jittered second bounds on save (and back on load).
  const [perHour, setPerHour] = useState(10)
  const [replyMin, setReplyMin] = useState(20)
  const [replyMax, setReplyMax] = useState(180)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const hydrated = useRef(false)

  const applySnapshot = useCallback((s: SimStatus, hydrateControls: boolean) => {
    setStatus(s)
    if (hydrateControls) {
      setAggression(s.aggression)
      setTone(s.tone ?? 'mixed')
      setMaxThreads(s.maxThreads)
      setPerHour(rangeToPerHour(s.spawnMinSec, s.spawnMaxSec))
      setReplyMin(s.replyMinSec)
      setReplyMax(s.replyMaxSec)
      setSelected(new Set(s.channelIds))
    }
  }, [])

  // Initial load + light polling for live counters.
  useEffect(() => {
    let alive = true
    const load = async (hydrate: boolean) => {
      try {
        const s = await simStatusAction()
        if (!alive) return
        setLoadError(false)
        applySnapshot(s, hydrate)
      } catch {
        if (alive) setLoadError(true)
      }
    }
    void load(!hydrated.current).then(() => {
      hydrated.current = true
    })
    const id = setInterval(() => void load(false), 6_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [applySnapshot])

  const running = status?.enabled ?? false

  function toggle(next: boolean) {
    startTransition(async () => {
      try {
        const s = await simToggleAction(next)
        applySnapshot(s, false)
        toast.success(next ? 'Симулятор запущен' : 'Симулятор остановлен')
      } catch {
        toast.error('Не удалось переключить симулятор')
      }
    })
  }

  function save() {
    // Convert the "per hour" target into jittered second bounds.
    const { min: sMin, max: sMax } = perHourToRange(perHour)
    const rMin = Math.min(replyMin, replyMax)
    const rMax = Math.max(replyMin, replyMax)
    startTransition(async () => {
      try {
        const s = await simUpdateSettingsAction({
          aggression,
          tone,
          maxThreads,
          spawnMinSec: sMin,
          spawnMaxSec: sMax,
          replyMinSec: rMin,
          replyMaxSec: rMax,
          channelIds: Array.from(selected),
        })
        applySnapshot(s, false)
        toast.success('Настройки сохранены')
      } catch {
        toast.error('Не удалось сохранить настройки')
      }
    })
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
                Работает в фоне даже с закрытой панелью.
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
          value={status?.activeThreads ?? 0}
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
          icon={Flame}
          label="Тон"
          value={aggressionLabel(status?.aggression ?? aggression)}
          small
        />
      </div>

      {/* ---- State breakdown ---- */}
      {status && (
        <Card className="flex flex-wrap gap-2 p-4">
          {(['opening', 'chatting', 'ignoring', 'done'] as const).map((st) => (
            <div
              key={st}
              className="flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-xs"
            >
              <span className="text-muted-foreground">{STATE_LABEL[st]}</span>
              <span className="font-semibold tabular-nums">{status.byState[st]}</span>
            </div>
          ))}
        </Card>
      )}

      {/* ---- Learn from real dialogues ---- */}
      <SecretSimulatorLearn
        key={status?.learnedProfile?.learnedAt ?? 'none'}
        initial={status?.learnedProfile ?? null}
      />

      {/* ---- Tunables ---- */}
      <Card className="flex flex-col gap-6 p-5">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" />
          <h3 className="font-semibold tracking-tight">Поведение</h3>
        </div>

        {/* Tone */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="sim-tone">Тон общения</Label>
            <span className="text-xs text-muted-foreground">
              {TONE_OPTIONS.find((o) => o.value === tone)?.hint}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5" id="sim-tone">
            {TONE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setTone(o.value)}
                className={cn(
                  'press-scale rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                  tone === o.value
                    ? 'border-foreground/25 bg-foreground text-background'
                    : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Aggression */}
        <SliderRow
          id="sim-aggr"
          label="Агрессия / мат"
          hint={aggressionLabel(aggression)}
          min={0}
          max={100}
          value={aggression}
          onChange={setAggression}
          format={(v) => `${v}%`}
        />

        {/* Max threads */}
        <SliderRow
          id="sim-threads"
          label="Одновременных диалогов"
          min={0}
          max={500}
          value={maxThreads}
          onChange={setMaxThreads}
          format={(v) => (v === 0 ? 'Без лимита' : String(v))}
        />

        {/* Spawn rate — expressed as new conversations per hour */}
        <SliderRow
          id="sim-rate"
          label="Новых диалогов в час"
          hint={perHourHint(perHour)}
          min={1}
          max={60}
          value={perHour}
          onChange={setPerHour}
          format={(v) => `${v}/час`}
        />

        {/* Reply delay */}
        <RangeRow
          label="Задержка ответа менеджеру"
          icon={Timer}
          min={5}
          max={900}
          step={5}
          low={replyMin}
          high={replyMax}
          onLow={setReplyMin}
          onHigh={setReplyMax}
          format={humanSecs}
        />

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
              владельца ��о вкладке «Каналы».
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

      {/* ---- Interactive test sandbox ---- */}
      <SecretSimulatorTest aggression={aggression} tone={tone} />
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

function SliderRow({
  id,
  label,
  hint,
  min,
  max,
  value,
  onChange,
  format,
}: {
  id: string
  label: string
  hint?: string
  min: number
  max: number
  value: number
  onChange: (v: number) => void
  format: (v: number) => string
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
          <span className="min-w-12 rounded-md bg-muted px-2 py-0.5 text-center text-xs font-semibold tabular-nums">
            {format(value)}
          </span>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="sim-range"
      />
    </div>
  )
}

function RangeRow({
  label,
  icon: Icon,
  min,
  max,
  step,
  low,
  high,
  onLow,
  onHigh,
  format,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  min: number
  max: number
  step: number
  low: number
  high: number
  onLow: (v: number) => void
  onHigh: (v: number) => void
  format: (v: number) => string
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5">
          <Icon className="size-3.5 text-muted-foreground" />
          {label}
        </Label>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums">
          {format(low)} – {format(high)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">от</span>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={low}
            onChange={(e) => onLow(Math.min(Number(e.target.value), high))}
            className="sim-range"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">до</span>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={high}
            onChange={(e) => onHigh(Math.max(Number(e.target.value), low))}
            className="sim-range"
          />
        </div>
      </div>
    </div>
  )
}
