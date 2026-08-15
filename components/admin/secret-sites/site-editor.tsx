'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CircleDot,
  Lightbulb,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Wallet,
  Zap,
} from 'lucide-react'
import {
  secretGetSiteAction,
  secretSaveSiteStateAction,
  secretTopUpSiteAction,
} from '@/app/actions/admin-secret'
import type {
  GodSite,
  SiteCampaign,
  SiteRecommendation,
  SiteState,
} from '@/lib/god-sites'
import { autoDayFraction } from '@/lib/god-sites-sim'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

/**
 * Full cabinet-state editor for a managed external site: login, balance,
 * currency and every field of every campaign. Saves the whole state
 * atomically under optimistic locking — a stale save answers a conflict and
 * the operator reopens the editor with fresh data.
 */

const CAMPAIGN_NUM_FIELDS: {
  key: 'cost' | 'shows' | 'clicks' | 'goals' | 'bounce' | 'revenue' | 'weeklyBudget'
  label: string
}[] = [
  { key: 'cost', label: 'Расход' },
  { key: 'shows', label: 'Показы' },
  { key: 'clicks', label: 'Клики' },
  { key: 'goals', label: 'Конверсии' },
  { key: 'bounce', label: 'Отказы, %' },
  { key: 'revenue', label: 'Доход' },
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
    revenue: 0,
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
  const drr = c.revenue > 0 ? (c.cost / c.revenue) * 100 : 0
  const roi = c.cost > 0 ? ((c.revenue - c.cost) / c.cost) * 100 : 0
  return [
    { label: 'CTR', value: `${nf.format(ctr)}%` },
    { label: 'CPC', value: nf.format(cpc) },
    { label: 'CPA', value: nf.format(cpa) },
    { label: 'CR', value: `${nf.format(cr)}%` },
    { label: 'ДРР', value: `${nf.format(drr)}%` },
    { label: 'ROI', value: `${nf.format(roi)}%` },
  ]
}

/**
 * "К этому часу скручено ~N%" preview — the SAME curve the server simulation
 * uses (lib/god-sites-sim.ts is pure and shared), so the preview can never
 * silently drift from what the vitrine actually shows.
 */
function previewDayFraction(tzOffsetHours: number): number {
  return autoDayFraction(new Date(), tzOffsetHours)
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
  const [revision, setRevision] = useState(site.revision)
  const [conflict, setConflict] = useState(false)
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    JSON.stringify(site.state),
  )
  const dirty = useMemo(
    () => JSON.stringify(state) !== savedSnapshot,
    [state, savedSnapshot],
  )
  const running = state.campaigns.filter((c) => c.status === 'running').length
  const autoEnabled = state.autoSpend?.enabled === true
  const autoPreviewFraction = useMemo(
    () => previewDayFraction(state.autoSpend?.tzOffsetHours ?? 3),
    [state.autoSpend?.tzOffsetHours],
  )
  const [topUpAmount, setTopUpAmount] = useState('')
  // Balance the vitrine shows right now: stored minus today's partial burn.
  // Same curve as the server (god-sites-sim is shared) — an estimate only in
  // the rare capped case when the balance runs out mid-day.
  const vitrineBalance = autoEnabled
    ? Math.max(
        0,
        state.balance -
          Math.min(
            autoPreviewFraction * (state.autoSpend?.dailyBudget ?? 0),
            state.balance,
          ),
      )
    : state.balance

  const recommendations = state.recommendations ?? []

  function patchCampaign(idx: number, patch: Partial<SiteCampaign>) {
    setState((s) => ({
      ...s,
      campaigns: s.campaigns.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }))
  }

  function patchRecommendation(idx: number, patch: Partial<SiteRecommendation>) {
    setState((s) => ({
      ...s,
      recommendations: (s.recommendations ?? []).map((r, i) =>
        i === idx ? { ...r, ...patch } : r,
      ),
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
          if (res.conflict) setConflict(true)
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  /**
   * Top-up: the server atomically ADDS to the stored balance (after banking
   * pending rollover days), then we adopt the fresh balance + revision in
   * place — other unsaved edits survive, and the next save won't conflict.
   */
  function topUp() {
    const amount = Number(topUpAmount.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Введите сумму пополнения больше нуля')
      return
    }
    startTransition(async () => {
      try {
        const res = await secretTopUpSiteAction(site.id, amount)
        if (!res.ok || res.balance === undefined || res.revision === undefined) {
          toast.error(res.message)
          return
        }
        setRevision(res.revision)
        setState((s) => ({ ...s, balance: res.balance as number }))
        // The new balance is already persisted — sync the snapshot so the
        // top-up alone doesn't flag the editor as dirty.
        setSavedSnapshot((snap) => {
          try {
            const parsed = JSON.parse(snap) as SiteState
            return JSON.stringify({ ...parsed, balance: res.balance })
          } catch {
            return snap
          }
        })
        setTopUpAmount('')
        toast.success(
          `Баланс пополнен: ${nf.format(res.balance)} ${state.currency}`,
        )
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  /**
   * Conflict recovery: pull the fresh state + revision in place, discarding
   * local edits — no need to close and reopen the editor.
   */
  function reloadFresh() {
    startTransition(async () => {
      try {
        const fresh = await secretGetSiteAction(site.id)
        if (!fresh) {
          toast.error('Сайт не найден — возможно, удалён')
          onClose()
          return
        }
        setState(fresh.state)
        setRevision(fresh.revision)
        setSavedSnapshot(JSON.stringify(fresh.state))
        setConflict(false)
        toast.success('Данные перезагружены')
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

      {/* Version conflict: someone saved newer data while this editor was
          open. Offer an in-place reload (discards local edits) — the old
          flow forced closing and reopening the whole editor. */}
      {conflict && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
          <p className="text-sm text-pretty">
            <span className="font-medium">Конфликт версий.</span>{' '}
            Данные сайта изменились, пока редактор был открыт — сохранение
            отклонено, чтобы не затереть новое.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={reloadFresh}
            disabled={pending}
            className="press-scale shrink-0 gap-1.5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Перезагрузить данные
          </Button>
        </div>
      )}

      {/* Cabinet header data */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Кабинет</h2>
          <span className="text-xs text-muted-foreground">
            — шапка витрины: логин, баланс, валюта и данные организации
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
            <Label htmlFor="site-balance">Баланс (задать точно)</Label>
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
            {autoEnabled && (
              <p className="text-xs text-muted-foreground">
                Сейчас на витрине ≈{' '}
                <span className="font-mono font-medium text-foreground">
                  {nf.format(vitrineBalance)} {state.currency}
                </span>{' '}
                — с учётом скрутки за сегодня
              </p>
            )}
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
        {/* Top-up: adds to the CURRENT balance server-side (atomic increment,
            applied instantly — no "Сохранить всё" needed). The plain input
            above stays for setting an exact value. */}
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
          <Label htmlFor="site-topup">Пополнить баланс</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="site-topup"
              type="number"
              min={0}
              step="0.01"
              value={topUpAmount}
              placeholder={`Сумма, ${state.currency}`}
              onChange={(e) => setTopUpAmount(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault()
                  topUp()
                }
              }}
              className="max-w-40 font-mono"
            />
            <Button
              size="sm"
              onClick={topUp}
              disabled={pending || Number(topUpAmount.replace(',', '.')) <= 0}
              className="press-scale gap-1.5"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Пополнить
            </Button>
            <span className="text-xs text-muted-foreground">
              прибавится к текущему балансу и применится сразу
            </span>
          </div>
        </div>

        {/* Organization card — окно по клику на аватар на витрине. Пустые
            поля не отправляются, страница показывает свой прочерк. */}
        <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-org">Организация</Label>
            <Input
              id="site-org"
              value={state.organization}
              placeholder="ООО Ромашка"
              onChange={(e) =>
                setState((s) => ({ ...s, organization: e.target.value }))
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-phone">Телефон</Label>
            <Input
              id="site-phone"
              value={state.phone}
              placeholder="+7 900 123-45-67"
              onChange={(e) => setState((s) => ({ ...s, phone: e.target.value }))}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-orgid">Идентификатор</Label>
            <Input
              id="site-orgid"
              value={state.orgId}
              placeholder={state.login || 'porg-xxxxxx'}
              onChange={(e) => setState((s) => ({ ...s, orgId: e.target.value }))}
              className="font-mono"
            />
          </div>
        </div>
      </Card>

      {/* Auto-spend */}
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
            <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
              Расход распределяется по активным кампаниям пропорционально их
              базовому расходу, а показы, клики, конверсии и доход
              масштабируются от их собственных пропорций (базовые числа
              кампании = её «профиль»). Ночью скрутка медленная, днём быстрее,
              пик вечером. Баланс уменьшается вживую; завершённые дни
              списываются с баланса насовсем при первом чтении нового дня —
              витриной или этой панелью, — так что скрутка накапливается день
              за днём и ничего не сбрасывается. Кампании со статусом
              «Остановлена» не тратят. Пополняйте баланс кнопкой «Пополнить» —
              она прибавляет к текущему, а не перезаписывает его.
            </p>
          </div>
        )}
      </Card>

      {/* Recommendations — optional curated cards; empty = page auto-computes */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Lightbulb
              className={`size-4 ${
                recommendations.length > 0
                  ? 'text-success'
                  : 'text-muted-foreground'
              }`}
            />
            <h2 className="text-sm font-semibold">Рекомендации</h2>
            <span className="text-xs text-muted-foreground">
              {recommendations.length > 0
                ? `— витрина покажет эти ${recommendations.length} шт.`
                : '— пусто: витрина считает рекомендации сама'}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setState((s) => ({
                ...s,
                recommendations: [
                  ...(s.recommendations ?? []),
                  {
                    id: `r${Date.now().toString(36)}`,
                    title: '',
                    text: '',
                    category: '',
                    campaign: '',
                    impact: '',
                  },
                ],
              }))
            }
            className="press-scale gap-1.5"
          >
            <Plus className="size-4" />
            Добавить рекомендацию
          </Button>
        </div>

        {recommendations.map((rec, idx) => (
          <div
            key={rec.id}
            className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3"
          >
            <div className="flex items-start gap-3">
              <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`rec-${rec.id}-title`} className="text-xs">
                    Заголовок
                  </Label>
                  <Input
                    id={`rec-${rec.id}-title`}
                    value={rec.title}
                    placeholder="Повысьте CTR объявлений"
                    onChange={(e) =>
                      patchRecommendation(idx, { title: e.target.value })
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`rec-${rec.id}-impact`} className="text-xs">
                    Эффект
                  </Label>
                  <Input
                    id={`rec-${rec.id}-impact`}
                    value={rec.impact}
                    placeholder="+15% конверсий"
                    onChange={(e) =>
                      patchRecommendation(idx, { impact: e.target.value })
                    }
                  />
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setState((s) => {
                    const next = (s.recommendations ?? []).filter(
                      (_, i) => i !== idx,
                    )
                    return {
                      ...s,
                      // Drop the key entirely when the list empties, so the
                      // payload omits it and the page returns to auto mode.
                      ...(next.length > 0
                        ? { recommendations: next }
                        : { recommendations: undefined }),
                    }
                  })
                }
                title="Удалить рекомендацию"
                className="press-scale mt-6 size-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`rec-${rec.id}-text`} className="text-xs">
                Текст
              </Label>
              <Textarea
                id={`rec-${rec.id}-text`}
                value={rec.text}
                rows={2}
                placeholder="Добавьте быстрые ссылки и уточнения в объявления."
                onChange={(e) =>
                  patchRecommendation(idx, { text: e.target.value })
                }
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`rec-${rec.id}-category`} className="text-xs">
                  Категория
                </Label>
                <Input
                  id={`rec-${rec.id}-category`}
                  value={rec.category}
                  placeholder="Объявления / Ставки / Бюджет…"
                  onChange={(e) =>
                    patchRecommendation(idx, { category: e.target.value })
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`rec-${rec.id}-campaign`} className="text-xs">
                  Кампания (пусто = весь аккаунт)
                </Label>
                <Input
                  id={`rec-${rec.id}-campaign`}
                  value={rec.campaign}
                  list="site-campaign-names"
                  placeholder="Название кампании"
                  onChange={(e) =>
                    patchRecommendation(idx, { campaign: e.target.value })
                  }
                />
              </div>
            </div>
          </div>
        ))}
        {/* Campaign-name suggestions for the recommendation binding — the
            contract references campaigns by NAME, so a datalist keeps free
            input possible while nudging toward exact existing names. */}
        <datalist id="site-campaign-names">
          {state.campaigns.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
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
