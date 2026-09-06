'use client'

/**
 * Отчётность по одному байеру для админа/руководителя: итоги и его источники со
 * сводками (баланс, освоение, лиды, CPL). Кнопка «Внести депозит» открывает
 * диалог для конкретного источника. Переиспользуется в /admin/buyers и
 * /head/buyers — различается только базовым путём навигации.
 */

import { useCallback, useState, useTransition } from 'react'
import {
  ArrowLeft,
  Coins,
  Loader2,
  Target,
  TrendingDown,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import { getBuyerReportAction } from '@/app/actions/source-finance'
import { DepositDialog } from '@/components/admin/buyers/deposit-dialog'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { formatMoney, formatPercent } from '@/lib/money'
import { cn } from '@/lib/utils'

type Report = Awaited<ReturnType<typeof getBuyerReportAction>>

export function BuyerReport({
  initial,
  onBack,
}: {
  initial: Report
  onBack: () => void
}) {
  const [report, setReport] = useState<Report>(initial)
  const [, startTransition] = useTransition()
  const [depositSource, setDepositSource] = useState<{
    id: string
    name: string
    currency: string
  } | null>(null)

  const buyer = report.buyer
  const t = report.totals

  const refresh = useCallback(() => {
    if (!buyer) return
    startTransition(async () => {
      setReport(await getBuyerReportAction(buyer.id))
    })
  }, [buyer])

  if (!buyer) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        Байер не найден.
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Назад">
          <ArrowLeft className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{buyer.name}</h2>
          <p className="text-xs text-muted-foreground">
            {buyer.email} · {t.sourcesCount} источник(ов)
          </p>
        </div>
        {t.pendingCount > 0 ? (
          <span className="rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs font-medium text-warning">
            {t.pendingCount} ждут решения байера
          </span>
        ) : null}
      </div>

      {/* Итоги по байеру */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <TotalTile
          icon={Wallet}
          label="Общий баланс"
          value={formatMoney(t.balance, 'RUB')}
          tone={t.balance >= 0 ? 'positive' : 'negative'}
        />
        <TotalTile
          icon={Coins}
          label="Подтверждено"
          value={formatMoney(t.confirmedDeposits, 'RUB')}
          hint={
            t.pendingDeposits > 0
              ? `+${formatMoney(t.pendingDeposits, 'RUB')} ждут`
              : undefined
          }
        />
        <TotalTile
          icon={TrendingDown}
          label="Потрачено"
          value={formatMoney(t.totalSpend, 'RUB')}
        />
        <TotalTile icon={Target} label="Лиды" value={String(t.leads)} />
      </div>

      {/* Источники байера */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">Источники</h3>
        {report.sources.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            У байера пока нет источников. Он добавит их сам из своего кабинета.
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {report.sources.map(({ source, summary }) => {
              const platform = platformOrCustom(source.platformKey)
              return (
                <Card key={source.id} className="flex flex-col gap-3 p-4">
                  <div className="flex items-center gap-3">
                    <PlatformLogo platform={platform} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{source.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {platform.name} · {source.currency}
                      </p>
                    </div>
                  </div>
                  {summary ? (
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <MiniStat
                        label="Баланс"
                        value={formatMoney(summary.balance, summary.currency)}
                        tone={summary.balance >= 0 ? 'positive' : 'negative'}
                      />
                      <MiniStat
                        label="Освоено"
                        value={formatPercent(summary.utilization)}
                      />
                      <MiniStat
                        label="CPL"
                        value={
                          summary.leads > 0
                            ? formatMoney(summary.cpl, summary.currency)
                            : '—'
                        }
                      />
                    </div>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDepositSource({
                        id: source.id,
                        name: source.name,
                        currency: source.currency,
                      })
                    }
                  >
                    <Coins className="size-4" />
                    Внести депозит
                  </Button>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <DepositDialog
        open={depositSource !== null}
        onOpenChange={(v) => !v && setDepositSource(null)}
        source={depositSource}
        onCreated={refresh}
      />
    </div>
  )
}

function TotalTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: typeof Wallet
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'positive' | 'negative'
}) {
  const toneCls = {
    default: 'text-foreground',
    positive: 'text-success',
    negative: 'text-destructive',
  }[tone]
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </span>
      <span className={cn('text-xl font-semibold tabular-nums', toneCls)}>
        {value}
      </span>
      {hint ? <span className="text-xs text-warning">{hint}</span> : null}
    </Card>
  )
}

function MiniStat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'positive' | 'negative'
}) {
  const toneCls = {
    default: 'text-foreground',
    positive: 'text-success',
    negative: 'text-destructive',
  }[tone]
  return (
    <div className="rounded-lg bg-muted/40 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={cn('text-sm font-semibold tabular-nums', toneCls)}>
        {value}
      </p>
    </div>
  )
}
