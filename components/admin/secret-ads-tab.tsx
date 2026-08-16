'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Check,
  Loader2,
  MousePointerClick,
  Eye,
  RefreshCw,
  RotateCcw,
  Target,
  TriangleAlert,
  Wallet,
} from 'lucide-react'
import {
  secretClearAdOverrideAction,
  secretSetAdOverrideAction,
  secretSyncAdAccountAction,
} from '@/app/actions/admin-secret'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/page-parts'
import { cn } from '@/lib/utils'

/** Метрики, которыми управляет god-страница. */
export type AdMetric = 'impressions' | 'clicks' | 'leads' | 'spend'

const METRIC_ORDER: AdMetric[] = ['impressions', 'clicks', 'leads', 'spend']

const METRIC_LABEL: Record<AdMetric, string> = {
  impressions: 'Показы',
  clicks: 'Клики',
  leads: 'Лиды',
  spend: 'Расход',
}

const METRIC_ICON: Record<AdMetric, typeof Eye> = {
  impressions: Eye,
  clicks: MousePointerClick,
  leads: Target,
  spend: Wallet,
}

export interface SecretAdOverride {
  value: number
  baseline: number
  updatedAt: string
}

export interface SecretAdAccount {
  id: string
  name: string
  platformLabel: string
  externalEnabled: boolean
  hasToken: boolean
  lastSyncAt: string | null
  syncError: string
  currency: string
  /** «Сырые» метрики (Яндекс или сумма ручных снимков). */
  base: Record<AdMetric, number>
  /** Итоговые метрики после корректировок. */
  effective: Record<AdMetric, number>
  overrides: Partial<Record<AdMetric, SecretAdOverride>>
}

function fmtNum(n: number, currency?: string): string {
  const s = new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(n)
  return currency ? `${s} ${currency}` : s
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'нет данных'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'нет данных'
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function SecretAdsTab({ accounts }: { accounts: SecretAdAccount[] }) {
  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={Target}
        title="Нет рекламных кабинетов"
        description="Добавьте кабинет в разделе «Финансы → Реклама», чтобы управлять его метриками здесь."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground text-pretty">
        Здесь можно зафиксировать собственные значения метрик. Система запоминает
        вашу цифру и текущие данные Яндекса: дальше показывается{' '}
        <span className="font-medium text-foreground">
          ваше значение + новый прирост Яндекса
        </span>
        . Например, если Яндекс отдаёт 1000 кликов, а вы ставите 2000 — при росте
        Яндекса до 1100 итог станет 2100.
      </p>
      {accounts.map((account) => (
        <AdAccountCard key={account.id} account={account} />
      ))}
    </div>
  )
}

function AdAccountCard({ account }: { account: SecretAdAccount }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [syncing, setSyncing] = useState(false)

  function syncNow() {
    setSyncing(true)
    startTransition(async () => {
      try {
        const res = await secretSyncAdAccountAction(account.id)
        if (res.ok) toast.success(res.message)
        else toast.error(res.message)
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      setSyncing(false)
      router.refresh()
    })
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{account.name}</span>
            <Badge variant="outline">{account.platformLabel}</Badge>
            {account.externalEnabled ? (
              <Badge className="bg-success/15 text-success">Интеграция</Badge>
            ) : (
              <Badge variant="secondary">Ручной ввод</Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            Синхронизация: {fmtDate(account.lastSyncAt)}
          </span>
        </div>
        {account.externalEnabled && (
          <Button
            variant="outline"
            size="sm"
            onClick={syncNow}
            disabled={pending || syncing}
          >
            {syncing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Синхронизировать
          </Button>
        )}
      </div>

      {account.syncError && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{account.syncError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {METRIC_ORDER.map((metric) => (
          <MetricRow
            key={metric}
            account={account}
            metric={metric}
            pending={pending}
            startTransition={startTransition}
            onDone={() => router.refresh()}
          />
        ))}
      </div>
    </Card>
  )
}

function MetricRow({
  account,
  metric,
  pending,
  startTransition,
  onDone,
}: {
  account: SecretAdAccount
  metric: AdMetric
  pending: boolean
  startTransition: (cb: () => void) => void
  onDone: () => void
}) {
  const override = account.overrides[metric]
  const base = account.base[metric]
  const effective = account.effective[metric]
  const currency = metric === 'spend' ? account.currency : undefined
  const Icon = METRIC_ICON[metric]

  const [draft, setDraft] = useState<string>(
    override ? String(override.value) : '',
  )

  function save() {
    const value = Number(draft.replace(',', '.'))
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Введите число ≥ 0.')
      return
    }
    startTransition(async () => {
      try {
        const res = await secretSetAdOverrideAction(account.id, metric, value)
        if (res.ok) toast.success(res.message)
        else toast.error(res.message)
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      onDone()
    })
  }

  function clear() {
    startTransition(async () => {
      try {
        const res = await secretClearAdOverrideAction(account.id, metric)
        if (res.ok) toast.success(res.message)
        else toast.error(res.message)
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      setDraft('')
      onDone()
    })
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-3',
        override && 'border-primary/40 bg-primary/5',
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon className="size-4 text-muted-foreground" />
          {METRIC_LABEL[metric]}
        </div>
        <div className="text-right">
          <div className="text-base font-semibold tabular-nums">
            {fmtNum(effective, currency)}
          </div>
          <div className="text-[11px] text-muted-foreground tabular-nums">
            Яндекс: {fmtNum(base, currency)}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          inputMode="decimal"
          placeholder="Своё значение"
          className="h-8"
          disabled={pending}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={save}
          disabled={pending || draft.trim() === ''}
          className="shrink-0"
        >
          <Check className="size-4" />
          Зафиксировать
        </Button>
        {override && (
          <Button
            size="sm"
            variant="ghost"
            onClick={clear}
            disabled={pending}
            className="shrink-0"
            title="Снять корректировку"
          >
            <RotateCcw className="size-4" />
          </Button>
        )}
      </div>

      {override && (
        <p className="text-[11px] text-muted-foreground">
          База зафиксирована на {fmtNum(override.baseline, currency)} ·
          прирост Яндекса сверх неё приплюсовывается автоматически.
        </p>
      )}
    </div>
  )
}
