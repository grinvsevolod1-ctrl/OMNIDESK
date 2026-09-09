'use client'

/**
 * Байер-центричный экран админа/руководителя: список медиабайеров с финансовыми
 * итогами (баланс, потрачено, лиды, источники). Клик по байеру открывает полную
 * отчётность (BuyerReport) с возможностью внести депозит. Общие действия
 * аккаунта (блокировка/сброс/удаление) остаются в строке через ManagerActions.
 */
import { useCallback, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight, Loader2, Megaphone, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { getBuyerReportAction } from '@/app/actions/source-finance'
import { useRealtimeRefresh } from '@/lib/hooks/use-lead-events'
import { BuyerReport } from '@/components/admin/buyers/buyer-report'
import { ManagerActions } from '@/components/admin/manager-actions'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { MoneyStack } from '@/components/money'
import type { CurrencyTotals } from '@/lib/data/source-finance'
import type { Manager } from '@/lib/types'

export interface BuyerTotals {
  byCurrency: CurrencyTotals[]
  leads: number
  pendingCount: number
  sourcesCount: number
}

export interface BuyerWithTotals {
  buyer: Manager
  totals: BuyerTotals
}

type Report = Awaited<ReturnType<typeof getBuyerReportAction>>

function StatusPill({ status }: { status: Manager['status'] }) {
  return (
    <Badge
      variant="outline"
      className={
        status === 'active'
          ? 'gap-1.5 border-transparent bg-success/15 text-success'
          : 'gap-1.5 border-transparent bg-muted text-muted-foreground'
      }
    >
      <span
        className={
          status === 'active'
            ? 'size-1.5 rounded-full bg-success'
            : 'size-1.5 rounded-full bg-muted-foreground'
        }
      />
      {status === 'active' ? 'Активен' : 'Заблокирован'}
    </Badge>
  )
}

export function BuyersTable({ buyers }: { buyers: BuyerWithTotals[] }) {
  const router = useRouter()
  const [report, setReport] = useState<Report | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  // Живые балансы: расход/депозит (событие 'source', миграция 170) и новые
  // лиды (событие 'lead' — влияет на счётчик лидов байера) перечитывают RSC.
  // Страница force-dynamic, поэтому router.refresh() обновляет карточки.
  // Пока открыт отчёт байера (report != null), таблица скрыта — refresh не
  // мешает, а свои финансы отчёт обновляет через source-detail внутри.
  useRealtimeRefresh({
    onRefresh: () => {
      if (!report) router.refresh()
    },
    lead: true,
    source: true,
    debounceMs: 500,
  })

  const openReport = useCallback((buyerId: string) => {
    setLoadingId(buyerId)
    startTransition(async () => {
      try {
        setReport(await getBuyerReportAction(buyerId))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось открыть отчёт.')
      } finally {
        setLoadingId(null)
      }
    })
  }, [])

  if (report) {
    return <BuyerReport initial={report} onBack={() => setReport(null)} />
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {buyers.map(({ buyer, totals }) => (
        <Card
          key={buyer.id}
          className="group flex flex-col gap-3 p-4 transition-colors hover:border-foreground/20"
        >
          <div className="flex items-start justify-between gap-2">
            <button
              type="button"
              onClick={() => openReport(buyer.id)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Megaphone className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1 font-medium">
                  <span className="truncate">{buyer.name}</span>
                  {loadingId === buyer.id ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {buyer.email}
                </span>
              </span>
            </button>
            <ManagerActions manager={buyer} />
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-muted/40 px-2 py-1.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Баланс
              </p>
              <MoneyStack
                items={totals.byCurrency.map((c) => ({
                  currency: c.currency,
                  amount: c.balance,
                }))}
                signedTone
                className="items-center text-sm font-semibold"
              />
            </div>
            <div className="rounded-lg bg-muted/40 px-2 py-1.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Потрачено
              </p>
              <MoneyStack
                items={totals.byCurrency.map((c) => ({
                  currency: c.currency,
                  amount: c.totalSpend,
                }))}
                className="items-center text-sm font-semibold"
              />
            </div>
            <div className="rounded-lg bg-muted/40 px-2 py-1.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Лиды
              </p>
              <p className="text-sm font-semibold tabular-nums">
                {totals.leads}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <StatusPill status={buyer.status} />
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Wallet className="size-3.5" />
              {totals.sourcesCount} источник(ов)
            </span>
          </div>

          {totals.pendingCount > 0 ? (
            <span className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1 text-center text-xs font-medium text-warning">
              {totals.pendingCount} депозит(ов) ждут решения байера
            </span>
          ) : null}
        </Card>
      ))}
    </div>
  )
}
