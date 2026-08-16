'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CircleDot,
  Download,
  Lightbulb,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Wallet,
  Zap,
} from 'lucide-react'
import {
  secretDownloadExtensionAction,
  secretGetSiteAction,
  secretSaveSiteStateAction,
  secretTopUpSiteAction,
} from '@/app/actions/admin-secret'
import { downloadBase64Zip } from '@/components/admin/secret-sites/download-zip'
import type {
  GodSite,
  SiteCampaign,
  SiteRecommendation,
  SiteState,
} from '@/lib/god-sites'
import { SpendCurveSettings } from '@/components/admin/secret-sites/spend-curve-settings'
import { CampaignCard } from '@/components/admin/secret-sites/campaign-card'
import { RecommendationCard } from '@/components/admin/secret-sites/recommendation-card'
import {
  nf,
  newCampaign,
  previewDayFraction,
} from '@/components/admin/secret-sites/site-editor-helpers'
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

export function SiteEditor({
  site,
  onClose,
  beta = false,
}: {
  site: GodSite
  onClose: () => void
  /** Beta "Сайты бета" tab: enables the one-click extension download. */
  beta?: boolean
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
    () => previewDayFraction(state.autoSpend),
    [state.autoSpend],
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

  /**
   * Build & download the browser extension for THIS site. Warn first: the
   * server rotates the API key, so any previously downloaded archive stops
   * working the moment this one is generated. Unsaved edits are flagged too —
   * the extension bakes in the CURRENT saved state, not the dirty draft.
   */
  function downloadExtension() {
    if (
      dirty &&
      !window.confirm(
        'Есть несохранённые изменения — расширение соберётся по последнему сохранённому состоянию. Продолжить?',
      )
    ) {
      return
    }
    if (
      !window.confirm(
        'Скачивание выдаст новый токен: все ранее скачанные архивы этого сайта перестанут работать. Продолжить?',
      )
    ) {
      return
    }
    startTransition(async () => {
      try {
        const res = await secretDownloadExtensionAction(site.id)
        if (res.ok && res.base64 && res.fileName) {
          downloadBase64Zip(res.base64, res.fileName)
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось собрать расширение')
      }
    })
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
          {beta && (
            <Button
              size="sm"
              variant="outline"
              onClick={downloadExtension}
              disabled={pending}
              className="press-scale gap-1.5"
              title="Собрать и скачать готовое расширение под этот сайт"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              Скачать расширение
            </Button>
          )}
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
          <RecommendationCard
            key={rec.id}
            rec={rec}
            onPatch={(patch) => patchRecommendation(idx, patch)}
            onRemove={() =>
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
          />
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
        <CampaignCard
          key={c.id}
          campaign={c}
          onPatch={(patch) => patchCampaign(idx, patch)}
          onRemove={() =>
            setState((s) => ({
              ...s,
              campaigns: s.campaigns.filter((_, i) => i !== idx),
            }))
          }
        />
      ))}
    </div>
  )
}
