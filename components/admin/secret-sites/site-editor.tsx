'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Loader2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react'
import { secretSaveSiteStateAction } from '@/app/actions/admin-secret'
import type { GodSite, SiteCampaign, SiteState } from '@/lib/god-sites'
import { Badge } from '@/components/ui/badge'
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

/**
 * Full cabinet-state editor for a managed external site: balance, currency
 * and every field of every campaign. Saves the whole state atomically under
 * optimistic locking — if the live page mutated data meanwhile, the save
 * answers a conflict and the operator reopens the editor with fresh data.
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

  function patchCampaign(idx: number, patch: Partial<SiteCampaign>) {
    setState((s) => ({
      ...s,
      campaigns: s.campaigns.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }))
  }

  function save() {
    startTransition(async () => {
      try {
        const res = await secretSaveSiteStateAction(site.id, state, revision)
        if (res.ok) {
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
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            className="press-scale gap-1.5"
          >
            <ArrowLeft className="size-4" />
            Назад
          </Button>
          <div>
            <p className="font-medium leading-tight">{site.title}</p>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{site.slug}</span>
              {' · rev '}
              {revision}
            </p>
          </div>
        </div>
        <Button size="sm" onClick={save} disabled={pending} className="press-scale gap-1.5">
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Сохранить всё
        </Button>
      </div>

      {/* Cabinet header data */}
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="site-login">Логин кабинета</Label>
          <Input
            id="site-login"
            value={state.login}
            placeholder="client-login"
            onChange={(e) => setState((s) => ({ ...s, login: e.target.value }))}
            className="w-52 font-mono"
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
            className="w-40 font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="site-currency">Валюта</Label>
          <Input
            id="site-currency"
            value={state.currency}
            onChange={(e) => setState((s) => ({ ...s, currency: e.target.value }))}
            className="w-20 text-center"
          />
        </div>
        <p className="pb-2 text-xs text-muted-foreground">
          Страница увидит изменения при следующем опросе (обычно до 5 секунд).
        </p>
      </Card>

      {/* Campaigns */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {'Кампании ('}
          {state.campaigns.length}
          {')'}
        </h2>
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

      {state.campaigns.map((c, idx) => (
        <Card key={c.id} className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <Badge
                variant="outline"
                className="shrink-0 font-mono text-xs"
                title="Номер кампании"
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
            <div className="flex items-center gap-2">
              <Select
                value={c.status}
                onValueChange={(v) =>
                  patchCampaign(idx, { status: v as 'running' | 'stopped' })
                }
              >
                <SelectTrigger
                  className="w-36"
                  aria-label="Статус кампании"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="running">Идут показы</SelectItem>
                  <SelectItem value="stopped">Остановлена</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setState((s) => ({
                    ...s,
                    campaigns: s.campaigns.filter((_, i) => i !== idx),
                  }))
                }
                title="Удалить кампанию"
                className="press-scale border-destructive/40 text-destructive hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>

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
        </Card>
      ))}
    </div>
  )
}
