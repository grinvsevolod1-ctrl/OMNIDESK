'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2, Minus, Plus, Rocket, Square } from 'lucide-react'
import {
  simStartCampaignAction,
  simStopCampaignAction,
} from '@/app/actions/client-sim'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SimStatus } from '@/lib/client-sim/types'

const MIN_COUNT = 1
const MAX_COUNT = 5000
const MIN_HOURS = 0.5
const MAX_HOURS = 720

/** Format an ISO deadline as a short "через 1 ч 20 мин" / "менее минуты". */
function untilLabel(iso: string | null): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'завершается…'
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'менее минуты'
  if (mins < 60) return `${mins} мин`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} ч ${m} мин` : `${h} ч`
}

/**
 * Campaign scheduler: "create N brand-new dialogues over the next H hours". A
 * running campaign paces spawns to hit the target within the window (lightly
 * jittered so it still looks organic), then auto-stops. Fully independent of the
 * steady per-day rate — this is the operator's on-demand burst tool.
 */
export function SecretSimulatorCampaign({
  status,
  onChanged,
}: {
  status: SimStatus | null
  onChanged: (s: SimStatus) => void
}) {
  const [count, setCount] = useState(15)
  const [hours, setHours] = useState(2)
  const [pending, startTransition] = useTransition()

  const active = status?.campaignActive ?? false
  const done = status
    ? Math.max(0, status.spawnedTotal - status.campaignBaseline)
    : 0
  const target = status?.campaignTarget ?? 0
  const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0

  function bumpCount(delta: number) {
    setCount((v) =>
      Math.min(Math.max((Math.round(v) || 0) + delta, MIN_COUNT), MAX_COUNT),
    )
  }
  function bumpHours(delta: number) {
    setHours((v) => {
      const next = Math.round(((Number(v) || 0) + delta) * 2) / 2
      return Math.min(Math.max(next, MIN_HOURS), MAX_HOURS)
    })
  }

  function start() {
    const c = Math.min(Math.max(Math.round(count) || MIN_COUNT, MIN_COUNT), MAX_COUNT)
    const h = Math.min(Math.max(Number(hours) || MIN_HOURS, MIN_HOURS), MAX_HOURS)
    startTransition(async () => {
      const res = await simStartCampaignAction({ count: c, hours: h })
      if (res.ok) {
        onChanged(res.status)
        toast.success(`Кампания запущена: ${c} диалогов за ${h} ч.`)
      } else {
        toast.error(res.error)
      }
    })
  }

  function stop() {
    startTransition(async () => {
      const res = await simStopCampaignAction({ keepEnabled: true })
      if (res.ok) {
        onChanged(res.status)
        toast.success('Кампания остановлена. Обычный режим продолжает работать.')
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-2">
        <Rocket className="size-4 text-muted-foreground" />
        <h3 className="font-semibold tracking-tight">Кампания (пакетный запуск)</h3>
      </div>

      {active ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm">
              Идёт кампания:{' '}
              <span className="font-semibold tabular-nums">
                {done} / {target}
              </span>{' '}
              диалогов создано
            </p>
            <span className="text-xs text-muted-foreground">
              осталось ~{untilLabel(status?.campaignEndsAt ?? null)}
            </span>
          </div>
          {/* Progress bar */}
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground text-pretty">
            Новые диалоги создаются вразнобой в пределах окна, чтобы приход был
            похож на живой. По достижении цели или по истечении времени кампания
            завершится сама.
          </p>
          <Button
            variant="destructive"
            className="gap-2 self-start"
            onClick={stop}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Square className="size-4" />
            )}
            Остановить кампанию
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Count */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="camp-count">Сколько диалогов создать</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0"
                  onClick={() => bumpCount(-1)}
                  disabled={count <= MIN_COUNT}
                  aria-label="Меньше"
                >
                  <Minus className="size-4" />
                </Button>
                <Input
                  id="camp-count"
                  type="number"
                  inputMode="numeric"
                  min={MIN_COUNT}
                  max={MAX_COUNT}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  onBlur={() =>
                    setCount((v) =>
                      Math.min(Math.max(Math.round(v) || MIN_COUNT, MIN_COUNT), MAX_COUNT),
                    )
                  }
                  className="h-10 max-w-28 text-center text-base font-semibold tabular-nums"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0"
                  onClick={() => bumpCount(1)}
                  disabled={count >= MAX_COUNT}
                  aria-label="Больше"
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            </div>

            {/* Hours */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="camp-hours">За сколько часов</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0"
                  onClick={() => bumpHours(-0.5)}
                  disabled={hours <= MIN_HOURS}
                  aria-label="Меньше"
                >
                  <Minus className="size-4" />
                </Button>
                <Input
                  id="camp-hours"
                  type="number"
                  inputMode="decimal"
                  step={0.5}
                  min={MIN_HOURS}
                  max={MAX_HOURS}
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                  onBlur={() =>
                    setHours((v) =>
                      Math.min(Math.max(Number(v) || MIN_HOURS, MIN_HOURS), MAX_HOURS),
                    )
                  }
                  className="h-10 max-w-28 text-center text-base font-semibold tabular-nums"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0"
                  onClick={() => bumpHours(0.5)}
                  disabled={hours >= MAX_HOURS}
                  aria-label="Больше"
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground text-pretty">
            Например: 15 диалогов за 2 часа — примерно один новый диалог каждые{' '}
            {(() => {
              const perGap = (hours * 60) / Math.max(1, count)
              return perGap < 1
                ? 'меньше минуты'
                : `${Math.round(perGap)} мин`
            })()}
            , с естественным разбросом. Запуск включит симулятор, если он выключен.
          </p>

          <Button
            size="lg"
            className="press-scale gap-2 self-start"
            onClick={start}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Rocket className="size-4" />
            )}
            Запустить кампанию
          </Button>
        </div>
      )}
    </Card>
  )
}
