'use client'

/**
 * Секция «Опт» вкладки «API TG» (Get My TG): архивы bulk-закупок. ID помнятся
 * в localStorage (у API нет их списка) + ручной поиск по ID. Вынесено из
 * secret-gmt-tab.tsx. Часть god-панели — инварианты AGENTS.md §4.
 */

import { useCallback, useState } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Boxes, Download, RefreshCw } from 'lucide-react'
import {
  secretGmtBulkStatusAction,
  type GmtBulkPurchase,
} from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/page-parts'
import { StatusBadge, fmtDate, fmtMoney, readBulkIds, rememberBulkId } from './shared'

export function BulkSection() {
  // Ленивый инициализатор безопасен: секция монтируется только по клику
  // на переключатель (после гидрации), SSR-рассинхрона быть не может.
  const [ids, setIds] = useState<number[]>(() =>
    typeof window === 'undefined' ? [] : readBulkIds(),
  )
  const [lookup, setLookup] = useState('')

  const addLookup = useCallback(() => {
    const id = Number(lookup.trim())
    if (!Number.isInteger(id) || id < 1) {
      toast.error('Введите числовой ID закупки')
      return
    }
    rememberBulkId(id)
    setIds(readBulkIds())
    setLookup('')
  }, [lookup])

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-5">
        <h3 className="font-medium">Оптовые закупки</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Создаются из каталога (режим «Опт»). Панель помнит созданные ID в
          этом браузере; любой ID можно добавить вручную. Архив (ZIP с
          сессиями) скачивается после готовности.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              )
                addLookup()
            }}
            placeholder="ID закупки, например 123"
            inputMode="numeric"
            className="h-8 w-48 tabular-nums"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 bg-transparent"
            onClick={addLookup}
          >
            Добавить
          </Button>
        </div>
      </Card>

      {ids.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="Оптовых закупок нет"
          description="Создайте закупку из каталога: кнопка «Купить» → режим «Опт»."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {ids.map((id) => (
            <BulkCard key={id} id={id} />
          ))}
        </div>
      )}
    </div>
  )
}

function BulkCard({ id }: { id: number }) {
  const { data, isLoading, error, mutate } = useSWR(
    ['gmt-bulk', id],
    async () => {
      const res = await secretGmtBulkStatusAction(id)
      if (!res.ok) throw new Error(res.message)
      return res.data as GmtBulkPurchase
    },
    {
      // Опрос каждые 20с, пока архив готовится.
      refreshInterval: (latest) => (latest?.status === 'PENDING' ? 20_000 : 0),
      revalidateOnFocus: false,
    },
  )

  if (isLoading && !data) {
    return <Skeleton className="h-20 rounded-md" />
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 p-3">
        <span className="text-sm text-muted-foreground">
          Закупка №{id}: не удалось загрузить (чужой или несуществующий ID)
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => void mutate()}
          aria-label="Повторить загрузку"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-xs text-muted-foreground">
            №{data.bulk_purchase_id}
          </span>
          <span className="text-sm font-medium">
            {data.country_code} · {data.quantity} шт
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {fmtMoney(data.price_per_account)}/шт · итого{' '}
            {fmtMoney(data.total_price)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {fmtDate(data.created_at)}
          </span>
          <StatusBadge status={data.status} />
        </div>
      </div>

      {data.status === 'SUCCESS' && data.item ? (
        <div>
          {/* Скачивание через god-роут: ключ API остаётся на сервере */}
          <a
            href={`/wijegniwjgwjog/api/gmt-bulk-download?id=${data.bulk_purchase_id}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Download className="size-3" aria-hidden />
            Скачать архив ({data.item.quantity} акк.)
          </a>
        </div>
      ) : null}
      {data.status === 'PENDING' ? (
        <p className="text-xs text-muted-foreground">
          Архив готовится — статус обновляется автоматически каждые 20 секунд.
        </p>
      ) : null}
    </div>
  )
}
