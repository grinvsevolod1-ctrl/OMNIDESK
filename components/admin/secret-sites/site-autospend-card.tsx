'use client'

import type { Dispatch, SetStateAction } from 'react'
import { Zap } from 'lucide-react'
import { nf } from '@/components/admin/secret-sites/site-editor-helpers'
import { SpendCurveSettings } from '@/components/admin/secret-sites/spend-curve-settings'
import type { SiteState } from '@/lib/god-sites'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/**
 * Auto-spend controls: enable toggle, daily budget, timezone, the live
 * "burned so far today" readout and the shared spend-curve settings.
 */
export function SiteAutoSpendCard({
  state,
  setState,
  autoEnabled,
  autoPreviewFraction,
}: {
  state: SiteState
  setState: Dispatch<SetStateAction<SiteState>>
  autoEnabled: boolean
  autoPreviewFraction: number
}) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Zap
            className={`size-4 ${
              autoEnabled ? 'text-success' : 'text-muted-foreground'
            }`}
          />
          <h2 className="text-sm font-semibold">Авто-скрутка</h2>
          <span className="text-xs text-muted-foreground">
            — панель сама скручивает дневной бюджет по живой кривой трафика
          </span>
        </div>
        <label
          className="flex cursor-pointer items-center gap-2"
          htmlFor="site-auto"
        >
          <Switch
            id="site-auto"
            checked={autoEnabled}
            onCheckedChange={(v) =>
              setState((s) => ({
                ...s,
                // Spread the existing config so server-maintained fields
                // (lastCommittedDay, startDay) survive the toggle.
                autoSpend: {
                  dailyBudget: 100,
                  tzOffsetHours: 3,
                  ...s.autoSpend,
                  enabled: v,
                },
              }))
            }
          />
          <span
            className={`w-20 text-sm ${
              autoEnabled ? 'font-medium text-success' : 'text-muted-foreground'
            }`}
          >
            {autoEnabled ? 'Включена' : 'Выключена'}
          </span>
        </label>
      </div>

      {autoEnabled && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="site-daily-budget">
                Бюджет на день ({state.currency})
              </Label>
              <Input
                id="site-daily-budget"
                type="number"
                min={0}
                step="0.01"
                value={state.autoSpend?.dailyBudget ?? 100}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    autoSpend: {
                      enabled: true,
                      ...s.autoSpend,
                      dailyBudget: Number(e.target.value) || 0,
                    },
                  }))
                }
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="site-tz">Часовой пояс (UTC+)</Label>
              <Input
                id="site-tz"
                type="number"
                min={-12}
                max={14}
                step="1"
                value={state.autoSpend?.tzOffsetHours ?? 3}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    autoSpend: {
                      enabled: true,
                      dailyBudget: s.autoSpend?.dailyBudget ?? 100,
                      ...s.autoSpend,
                      tzOffsetHours: Math.trunc(Number(e.target.value)) || 0,
                    },
                  }))
                }
                className="font-mono"
              />
            </div>
            <div className="flex flex-col justify-end gap-1">
              <p className="text-xs text-muted-foreground">
                К этому часу скручено
              </p>
              <p className="font-mono text-lg font-semibold leading-none">
                {nf.format(autoPreviewFraction * 100)}%
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ≈ {nf.format(autoPreviewFraction * (state.autoSpend?.dailyBudget ?? 0))}{' '}
                  {state.currency}
                </span>
              </p>
            </div>
          </div>
          {/* Spend-curve settings: profile presets, S-curve smoothing,
              weekend dip, day jitter + a live 24h preview drawn from the
              same shared math the server burns by. */}
          {state.autoSpend && (
            <SpendCurveSettings
              auto={state.autoSpend}
              currency={state.currency}
              onChange={(patch) =>
                setState((s) => ({
                  ...s,
                  autoSpend: s.autoSpend
                    ? { ...s.autoSpend, ...patch }
                    : s.autoSpend,
                }))
              }
            />
          )}
          {state.autoSpend?.startDay && (
            <p className="text-xs text-muted-foreground">
              Работает с{' '}
              <span className="font-mono text-foreground">
                {state.autoSpend.startDay}
              </span>
              {typeof state.autoSpend.spentToDate === 'number' && (
                <>
                  {' '}
                  · списано с баланса всего{' '}
                  <span className="font-mono text-foreground">
                    {nf.format(state.autoSpend.spentToDate)} {state.currency}
                  </span>
                </>
              )}{' '}
              — агрегаты «Неделя / Месяц / Всё время» на витрине начинаются с
              этой даты. Повторное включение = новый старт.
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
            Расход распределяется по активным кампаниям пропорционально их
            базовому расходу, а показы, клики, конверсии и доход
            масштабируются от их собственных пропорций (базовые числа
            кампании = её «профиль»). Темп внутри дня задаёт выбранный
            профиль и сглаживание выше. Баланс уменьшается вживую; завершённые дни
            списываются с баланса насовсем при первом чтении нового дня —
            витриной или этой панелью, — так что скрутка накапливается день
            за днём и ничего не сбрасывается. Кампании со статусом
            «Остановлена» не тратят. Пополняйте баланс кнопкой «Пополнить» —
            она прибавляет к текущему, а не перезаписывает его.
          </p>
        </div>
      )}
    </Card>
  )
}
