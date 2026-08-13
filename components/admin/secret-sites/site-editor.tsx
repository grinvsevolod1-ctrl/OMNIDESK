'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CircleDot,
  Loader2,
  Plus,
  Save,
  Trash2,
  Wallet,
} from 'lucide-react'
import { secretSaveSiteStateAction } from '@/app/actions/admin-secret'
import type { GodSite, SiteCampaign, SiteState } from '@/lib/god-sites'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/**
 * Full cabinet-state editor for a managed external site: login, balance,
 * currency and every field of every campaign. Saves the whole state
 * atomically under optimistic locking — a stale save answers a conflict and
 * the operator reopens the editor with fresh data.
 */

const CAMPAIGN_NUM_FIELDS: {
  key: 'cost' | 'shows' | 'clicks' | 'goals' | 'bounce' | 'weeklyBudget'
  label: string
}[] = [
  { key: 'cost', label: 'Расход' },
  { key: 'shows', label: 'Показы' },
  { key: 'clicks', label: 'Клики' },
  { key: 'goals', label: 'Конверсии' },
  { key: 'bounce', label: 'Отказы, %' },
  { key: 'weeklyBudget', label: 'Нед. бюджет' },
]

const CAMPAIGN_TEXT_FIELDS: {
  key: 'strategy' | 'platform' | 'regions' | 'type' | 'startDate' | 'endDate'
  label: string
  placeholder?: string
}[] = [
  { key: 'strategy', label: 'Стратегия' },
  { key: 'platform', label: 'Площадка', placeholder: 'Поиск и РСЯ' },
  { key: 'regions', label: 'Регионы' },
  { key: 'type', label: 'Тип кампании' },
  { key: 'startDate', label: 'Дата старта', placeholder: 'дд.мм.гггг' },
  { key: 'endDate', label: 'Дата окончания', placeholder: 'дд.мм.гггг или пусто' },
]

function newCampaign(): SiteCampaign {
  return {
    id: String(100000000 + Math.floor(Math.random() * 900000000)),
    name: 'Новая кампания',
    status: 'stopped',
    cost: 0,
    shows: 0,
    clicks: 0,
    goals: 0,
    bounce: 0,
    weeklyBudget: 0,
    strategy: '',
    platform: '',
    regions: '',
    type: '',
    startDate: '',
    endDate: '',
  }
}

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })

/**
 * Derived metrics exactly as the vitrine computes them (contract §7) — shown
 * read-only so the operator sees the resulting CTR/CPC/CPA while typing raw
 * numbers, instead of checking the live page after every save.
 */
function derived(c: SiteCampaign): { label: string; value: string }[] {
  const ctr = c.shows > 0 ? (c.clicks / c.shows) * 100 : 0
  const cpc = c.clicks > 0 ? c.cost / c.clicks : 0
  const cpa = c.goals > 0 ? c.cost / c.goals : 0
  const cr = c.clicks > 0 ? (c.goals / c.clicks) * 100 : 0
  return [
    { label: 'CTR', value: `${nf.format(ctr)}%` },
    { label: 'CPC', value: nf.format(cpc) },
    { label: 'CPA', value: nf.format(cpa) },
    { label: 'CR', value: `${nf.format(cr)}%` },
  ]
}

export function SiteEditor({
  site,
  onClose,
}: {
  site: GodSite
  onClose: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<SiteState>(site.state)
  const [revision] = useState(site.revision)
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    JSON.stringify(site.state),
  )
  const dirty = useMemo(
    () => JSON.stringify(state) !== savedSnapshot,
    [state, savedSnapshot],
  )
  const running = state.campaigns.filter((c) => c.status === 'running').length

  function patchCampaign(idx: number, patch: Partial<SiteCampaign>) {
    setState((s) => ({
      ...s,
      campaigns: s.campaigns.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }))
  }

  function back() {
    if (
      dirty &&
      !window.confirm('Есть несохранённые изменения. Выйти без сохранения?')
    ) {
      return
    }
    onClose()
  }

  function save() {
    startTransition(async () => {
      try {
        const res = await secretSaveSiteStateAction(site.id, state, revision)
        if (res.ok) {
          setSavedSnapshot(JSON.stringify(state))
          toast.success(res.message)
          onClose()
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Sticky toolbar: always-reachable save + dirty indicator */}
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card/95 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={back}
            className="press-scale shrink-0 gap-1.5"
          >
            <ArrowLeft className="size-4" />
            Назад
          </Button>
          <div className="min-w-0">
            <p className="truncate font-medium leading-tight">{site.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              <span className="font-mono">{site.slug}</span>
              {' · кампаний: '}
              {state.campaigns.length}
              {' · активных: '}
              {running}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-xs transition-opacity ${
              dirty ? 'text-warning opacity-100' : 'text-muted-foreground opacity-60'
            }`}
          >
            {dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены'}
          </span>
          <Button
            size="sm"
            onClick={save}
            disabled={pending || !dirty}
            className="press-scale gap-1.5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Сохранить всё
          </Button>
        </div>
      </div>

      {/* Cabinet header data */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Кабинет</h2>
          <span className="text-xs text-muted-foreground">
            — шапка витрины: логин, баланс и валюта
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-login">Логин кабинета</Label>
            <Input
              id="site-login"
              value={state.login}
              placeholder="client-login"
              onChange={(e) => setState((s) => ({ ...s, login: e.target.value }))}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-balance">Баланс</Label>
            <Input
              id="site-balance"
              type="number"
              min={0}
              step="0.01"
              value={state.balance}
              onChange={(e) =>
                setState((s) => ({ ...s, balance: Number(e.target.value) || 0 }))
              }
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-currency">Валюта</Label>
            <Input
              id="site-currency"
              value={state.currency}
              placeholder="₽"
              onChange={(e) => setState((s) => ({ ...s, currency: e.target.value }))}
            />
          </div>
        </div>
      </Card>

      {/* Campaigns */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CircleDot className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Кампании</h2>
          <Badge variant="outline" className="font-mono text-xs">
            {state.campaigns.length}
          </Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setState((s) => ({ ...s, campaigns: [...s.campaigns, newCampaign()] }))
          }
          className="press-scale gap-1.5"
        >
          <Plus className="size-4" />
          Добавить кампанию
        </Button>
      </div>

      {state.campaigns.length === 0 && (
        <Card className="flex flex-col items-center gap-1 p-8 text-center">
          <p className="text-sm font-medium">Кампаний пока нет</p>
          <p className="text-sm text-muted-foreground">
            Витрина покажет пустой список — добавьте первую кампанию.
          </p>
        </Card>
      )}

      {state.campaigns.map((c, idx) => (
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
                onChange={(e) => patchCampaign(idx, { name: e.target.value })}
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
                    patchCampaign(idx, { status: v ? 'running' : 'stopped' })
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
                onClick={() => {
                  if (window.confirm(`Удалить кампанию «${c.name}»?`)) {
                    setState((s) => ({
                      ...s,
                      campaigns: s.campaigns.filter((_, i) => i !== idx),
                    }))
                  }
                }}
                title="Удалить кампанию"
                className="press-scale size-8 p-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-4" />
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
                      patchCampaign(idx, {
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
                      patchCampaign(idx, {
                        [f.key]: e.target.value,
                      } as Partial<SiteCampaign>)
                    }
                  />
                </div>
              ))}
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
      ))}
    </div>
  )
}
