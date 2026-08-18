'use client'

import { useState } from 'react'
import { CalendarClock, ChevronDown, CopyPlus, Trash2 } from 'lucide-react'
import type {
  PeriodMetricField,
  PeriodOverride,
  SiteCampaign,
  SitePeriod,
} from '@/lib/god-sites'
// VALUE import from god-sites-types (not god-sites): the DB layer is
// `server-only` and would poison this client component's bundle.
import { PERIOD_METRIC_FIELDS } from '@/lib/god-sites-types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  CAMPAIGN_NUM_FIELDS,
  CAMPAIGN_TEXT_FIELDS,
  derived,
} from '@/components/admin/secret-sites/site-editor-helpers'

/**
 * Periods that accept manual metric overlays. `today` is deliberately
 * absent — the projection never applies it (today is always the live view)
 * and the validator drops it, so offering it here would be a silent no-op.
 */
const OVERRIDE_PERIODS: { period: SitePeriod; label: string }[] = [
  { period: 'yesterday', label: 'Вчера' },
  { period: 'week', label: 'Неделя' },
  { period: 'month', label: 'Месяц' },
  { period: 'all', label: 'Всё время' },
]

/** Labels for the override inputs — same wording as the base metric grid. */
const OVERRIDE_FIELD_LABELS: Record<PeriodMetricField, string> = {
  cost: 'Расход',
  shows: 'Показы',
  clicks: 'Клики',
  goals: 'Конверсии',
  bounce: 'Отказы, %',
  revenue: 'Доход',
}

/**
 * Editor for a single campaign row of a managed site: name, run/stop, raw
 * metric inputs, optional per-period metric overrides and a read-only
 * derived-metrics footer. Stateless w.r.t. campaign data — the parent editor
 * owns the state and passes patch/remove callbacks, so a long site can map
 * over campaigns without re-rendering the whole form.
 */
export function CampaignCard({
  campaign: c,
  overrides,
  onPatch,
  onOverridePatch,
  onDuplicate,
  onRemove,
}: {
  campaign: SiteCampaign
  /** This campaign's per-period overlays (period → override), possibly sparse. */
  overrides: Partial<Record<SitePeriod, PeriodOverride | undefined>>
  onPatch: (patch: Partial<SiteCampaign>) => void
  /** value === undefined clears the override (field returns to auto). */
  onOverridePatch: (
    period: SitePeriod,
    field: PeriodMetricField,
    value: number | undefined,
  ) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const overrideCount = OVERRIDE_PERIODS.reduce(
    (n, { period }) => n + Object.keys(overrides[period] ?? {}).length,
    0,
  )
  // Open by default when overrides already exist — hidden curated data that
  // silently shapes the vitrine is worse than a slightly taller card.
  const [periodsOpen, setPeriodsOpen] = useState(overrideCount > 0)
  const [activePeriod, setActivePeriod] = useState<SitePeriod>('week')
  return (
    <Card key={c.id} className="flex flex-col gap-0 overflow-hidden p-0">
      {/* Campaign header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Badge
            variant="outline"
            className="shrink-0 font-mono text-xs text-muted-foreground"
            title="Номер кампании (виден на витрине)"
          >
            {c.id}
          </Badge>
          <Input
            value={c.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            className="max-w-md font-medium"
            aria-label="Название кампании"
          />
        </div>
        <div className="flex items-center gap-3">
          <label
            className="flex cursor-pointer items-center gap-2"
            htmlFor={`c-${c.id}-status`}
          >
            <Switch
              id={`c-${c.id}-status`}
              checked={c.status === 'running'}
              onCheckedChange={(v) =>
                onPatch({ status: v ? 'running' : 'stopped' })
              }
            />
            <span
              className={`w-24 text-sm ${
                c.status === 'running'
                  ? 'font-medium text-success'
                  : 'text-muted-foreground'
              }`}
            >
              {c.status === 'running' ? 'Идут показы' : 'Остановлена'}
            </span>
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDuplicate}
            title="Дублировать кампанию (копия создаётся остановленной)"
            className="press-scale size-8 p-0 text-muted-foreground hover:text-foreground"
          >
            <CopyPlus className="size-4" />
            <span className="sr-only">Дублировать кампанию</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm(`Удалить кампанию «${c.name}»?`)) {
                onRemove()
              }
            }}
            title="Удалить кампанию"
            className="press-scale size-8 p-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
            <span className="sr-only">Удалить кампанию</span>
          </Button>
        </div>
      </div>

      {/* Metrics */}
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {CAMPAIGN_NUM_FIELDS.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`c-${c.id}-${f.key}`} className="text-xs">
                {f.label}
              </Label>
              <Input
                id={`c-${c.id}-${f.key}`}
                type="number"
                min={0}
                step="0.01"
                value={c[f.key]}
                onChange={(e) =>
                  onPatch({
                    [f.key]: Number(e.target.value) || 0,
                  } as Partial<SiteCampaign>)
                }
                className="font-mono"
              />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CAMPAIGN_TEXT_FIELDS.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`c-${c.id}-${f.key}`} className="text-xs">
                {f.label}
              </Label>
              <Input
                id={`c-${c.id}-${f.key}`}
                value={c[f.key]}
                placeholder={f.placeholder}
                onChange={(e) =>
                  onPatch({
                    [f.key]: e.target.value,
                  } as Partial<SiteCampaign>)
                }
              />
            </div>
          ))}
        </div>

        {/* Per-period metric overrides — the backend (validation + projection)
            has supported these all along; this is the first UI for them.
            Empty input = inherit (auto/simulated value for that period). */}
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/20">
          <button
            type="button"
            onClick={() => setPeriodsOpen((v) => !v)}
            aria-expanded={periodsOpen}
            className="flex items-center gap-2 px-3 py-2.5 text-left"
          >
            <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-xs font-semibold">Метрики по периодам</span>
            {overrideCount > 0 && (
              <Badge variant="outline" className="font-mono text-[10px]">
                {overrideCount}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              — точечно переопределить «Вчера / Неделя / Месяц / Всё время»
            </span>
            <ChevronDown
              className={`ml-auto size-4 shrink-0 text-muted-foreground transition-transform ${
                periodsOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {periodsOpen && (
            <div className="flex flex-col gap-3 px-3 pb-3">
              <div className="flex flex-wrap gap-1">
                {OVERRIDE_PERIODS.map(({ period, label }) => {
                  const count = Object.keys(overrides[period] ?? {}).length
                  const active = activePeriod === period
                  return (
                    <button
                      key={period}
                      type="button"
                      onClick={() => setActivePeriod(period)}
                      aria-pressed={active}
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        active
                          ? 'border-primary/40 bg-primary/10 font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      {label}
                      {count > 0 && (
                        <span className="ml-1.5 font-mono text-[10px] text-primary">
                          {count}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {PERIOD_METRIC_FIELDS.map((f) => {
                  const ov = overrides[activePeriod]?.[f]
                  return (
                    <div key={f} className="flex flex-col gap-1.5">
                      <Label
                        htmlFor={`c-${c.id}-ov-${activePeriod}-${f}`}
                        className="text-xs"
                      >
                        {OVERRIDE_FIELD_LABELS[f]}
                      </Label>
                      <Input
                        id={`c-${c.id}-ov-${activePeriod}-${f}`}
                        type="number"
                        min={0}
                        step="0.01"
                        value={ov ?? ''}
                        placeholder="авто"
                        onChange={(e) =>
                          onOverridePatch(
                            activePeriod,
                            f,
                            e.target.value === ''
                              ? undefined
                              : Number(e.target.value) || 0,
                          )
                        }
                        className="font-mono"
                      />
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground text-pretty">
                Пустое поле = «авто»: витрина покажет значение из базовых метрик
                или из авто-скрутки. Заполненное — жёстко переопределяет метрику
                для выбранного периода (приоритетнее симуляции).
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Derived preview — what the vitrine will render from these numbers */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t bg-muted/40 px-4 py-2.5">
        <span className="text-xs text-muted-foreground">На витрине:</span>
        {derived(c).map((m) => (
          <span key={m.label} className="text-xs">
            <span className="text-muted-foreground">{m.label} </span>
            <span className="font-mono font-medium">{m.value}</span>
          </span>
        ))}
      </div>
    </Card>
  )
}
