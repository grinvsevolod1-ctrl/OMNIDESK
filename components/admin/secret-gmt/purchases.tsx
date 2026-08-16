'use client'

/**
 * Секция «Покупки» вкладки «API TG» (Get My TG): список покупок со статусами,
 * кредами, возвратом и серверной пагинацией. Вынесено из secret-gmt-tab.tsx.
 * Часть god-панели — инварианты AGENTS.md §4.
 */

import { useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  UserPlus,
} from 'lucide-react'
import {
  secretGmtPurchasesAction,
  secretGmtRefundAction,
  secretGmtRequestCodeAction,
  type GmtPurchase,
  type GmtPurchaseStatus,
} from '@/app/actions/admin-secret'
import { type ImportState } from '@/components/admin/secret-gmt/use-auto-import'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import {
  CopyButton,
  StatusBadge,
  fmtDate,
  fmtMoney,
  normalizePhoneKey,
  refundEtaMinutes,
} from './shared'

const FILTERS: { id: GmtPurchaseStatus | 'ALL'; label: string }[] = [
  { id: 'ALL', label: 'Все' },
  { id: 'PENDING', label: 'Ожидают' },
  { id: 'SUCCESS', label: 'Готовые' },
  { id: 'ERROR', label: 'Ошибки' },
  { id: 'REFUND', label: 'Возвраты' },
]

export function PurchasesSection({
  onBalanceChanged,
  importedSet,
  onImport,
  importState,
}: {
  onBalanceChanged: () => void
  importedSet: Set<string>
  onImport: (purchaseId: number) => void
  importState: ImportState
}) {
  const [filter, setFilter] = useState<GmtPurchaseStatus | 'ALL'>('ALL')
  const [page, setPage] = useState(1)

  const { data, isLoading, mutate } = useSWR(
    ['gmt-purchases', filter, page],
    async () => {
      const res = await secretGmtPurchasesAction(
        filter === 'ALL' ? undefined : filter,
        page,
      )
      if (!res.ok) throw new Error(res.message)
      return res.data
    },
    {
      keepPreviousData: true,
      // Пока в выборке есть PENDING — код может прийти в любой момент.
      refreshInterval: (latest) =>
        latest?.items.some((p) => p.status === 'PENDING') ? 15_000 : 0,
    },
  )

  const items = data?.items ?? []
  const pagination = data?.pagination

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">Покупки</h3>
          <p className="text-xs text-muted-foreground">
            PENDING → «Получить код» → готовые креды для входа
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setFilter(f.id)
                  setPage(1)
                }}
                className={cn(
                  'rounded px-2 py-1 text-xs transition-colors',
                  filter === f.id
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => void mutate()}
          >
            <RefreshCw className="size-3.5" />
            Обновить
          </Button>
        </div>
      </div>

      {isLoading && items.length === 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-md" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={Package}
            title="Покупок нет"
            description="Выберите страну в каталоге — купленный номер появится здесь."
          />
        </div>
      ) : (
        <div className="mt-3 divide-y divide-border">
          {items.map((p) => (
            <PurchaseRow
              key={p.id}
              purchase={p}
              onChanged={() => {
                void mutate()
                onBalanceChanged()
              }}
              imported={
                p.phone_number
                  ? importedSet.has(normalizePhoneKey(p.phone_number))
                  : false
              }
              onImport={onImport}
              importState={importState}
            />
          ))}
        </div>
      )}

      {pagination && pagination.total_pages > 1 ? (
        <div className="mt-3 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 bg-transparent px-2"
            disabled={!pagination.has_previous}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="Предыдущая страница"
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {pagination.current_page} / {pagination.total_pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 bg-transparent px-2"
            disabled={!pagination.has_next}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Следующая страница"
          >
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </Card>
  )
}

function PurchaseRow({
  purchase: p,
  onChanged,
  imported,
  onImport,
  importState,
}: {
  purchase: GmtPurchase
  onChanged: () => void
  imported: boolean
  onImport: (purchaseId: number) => void
  importState: ImportState
}) {
  const [pending, startTransition] = useTransition()
  const [revealed, setRevealed] = useState(false)
  const eta = refundEtaMinutes(p)
  const canRefund = p.status === 'PENDING' && !p.verification && eta === 0
  // Импорт этой покупки прямо сейчас ведёт оркестратор?
  const importingThis =
    importState.purchaseId === p.id && importState.phase !== 'idle'
  const importBusy = importState.phase !== 'idle' && importState.phase !== 'done' && importState.phase !== 'error'

  function requestCode() {
    startTransition(async () => {
      const res = await secretGmtRequestCodeAction(p.id)
      if (res.ok && res.data) {
        const st = res.data.code_request.status
        if (st === 'success') toast.success('Код получен')
        else toast.info('Запрос кода отправлен — обычно занимает 5–30 секунд')
      } else if (res.message.toLowerCase().includes('conflict')) {
        // Повторный request-code даёт conflict — просто перечитываем детали.
        toast.info('Код уже был запрошен — обновляю данные')
      } else {
        toast.error(res.message)
      }
      onChanged()
    })
  }

  function refund() {
    if (
      !window.confirm(
        `Вернуть покупку №${p.id}? Деньги вернутся на баланс Get My TG.`,
      )
    )
      return
    startTransition(async () => {
      const res = await secretGmtRefundAction(p.id)
      if (res.ok) toast.success('Средства возвращены на баланс')
      else toast.error(res.message)
      onChanged()
    })
  }

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-muted-foreground">#{p.id}</span>
        <span className="font-mono text-sm font-medium">
          {p.phone_number ?? '№ не выдан'}
        </span>
        {p.phone_number ? (
          <CopyButton value={p.phone_number} label="номер" />
        ) : null}
        <StatusBadge status={p.status} />
        {p.purchase_type === 'BULK' ? (
          <Badge variant="outline" className="border-border text-muted-foreground">
            Опт
          </Badge>
        ) : null}
        {imported ? (
          <Badge
            variant="outline"
            className="gap-1 border-success/40 text-success"
          >
            <CheckCircle2 className="size-3" />В god-аккаунтах
          </Badge>
        ) : null}
        {importingThis && importBusy ? (
          <Badge
            variant="outline"
            className="gap-1 border-primary/40 text-primary"
          >
            <Loader2 className="size-3 animate-spin" />
            Импорт…
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {p.display_name.ru} · {fmtMoney(p.price)} · {fmtDate(p.created_at)}
        </span>
      </div>

      {p.verification ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm">
          <span className="flex items-center gap-1.5">
            <KeyRound className="size-3.5 text-success" />
            Код:{' '}
            <span className="font-mono font-semibold tabular-nums">
              {revealed ? p.verification.code : '•••••'}
            </span>
            <CopyButton value={p.verification.code} label="код" />
          </span>
          {p.verification.password ? (
            <span className="flex items-center gap-1.5">
              Пароль 2FA:{' '}
              <span className="font-mono font-semibold">
                {revealed ? p.verification.password : '••••••••'}
              </span>
              <CopyButton value={p.verification.password} label="пароль" />
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? (
              <EyeOff className="size-3" />
            ) : (
              <Eye className="size-3" />
            )}
            {revealed ? 'Скрыть' : 'Показать'}
          </Button>
        </div>
      ) : null}

      {p.status === 'PENDING' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={pending || importBusy}
            onClick={() => onImport(p.id)}
            title="Панель сама создаст god-аккаунт, получит код и войдёт"
          >
            {importingThis && importBusy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <UserPlus className="size-3" />
            )}
            Импортировать в god-аккаунты
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 bg-transparent px-2.5 text-xs"
            disabled={pending || importBusy}
            onClick={requestCode}
            title="Только запросить код, без автоимпорта"
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <KeyRound className="size-3" />
            )}
            Получить код
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 bg-transparent px-2.5 text-xs"
            disabled={!canRefund || pending}
            onClick={refund}
            title={
              canRefund
                ? 'Вернуть деньги на баланс'
                : `Возврат доступен через ${eta} мин (правило 20 минут)`
            }
          >
            <RotateCcw className="size-3" />
            {canRefund ? 'Вернуть средства' : `Возврат через ${eta} мин`}
          </Button>
        </div>
      ) : null}

      {p.status === 'SUCCESS' && !imported ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={importBusy}
            onClick={() => onImport(p.id)}
            title="Аккаунт куплен, но ещё не заведён в панель — импортировать"
          >
            {importingThis && importBusy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <UserPlus className="size-3" />
            )}
            Импортировать в god-аккаунты
          </Button>
        </div>
      ) : null}
    </div>
  )
}
