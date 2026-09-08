'use client'

/**
 * Обзор медиабайера: карточки его источников со статистикой написавших и
 * переданных куратору за сегодня. Отсюда байер добавляет источники и переходит
 * в детальный учёт. Лиды вынесены в отдельную вкладку «Лиды» (/buyer/leads).
 */

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MessageSquare, Plus, Send, Wallet } from 'lucide-react'
import type { BuyerSourceOverview } from '@/app/actions/buyer'
import { AddSourceModal } from '@/components/buyer/add-source-modal'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { PageHeader } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

/**
 * Карточка источника: логотип площадки, имя, баланс и счётчики за сегодня
 * (написали / передано куратору). Вся карточка — ссылка на детальный учёт.
 */
function SourceCard({ source }: { source: BuyerSourceOverview }) {
  const platform = platformOrCustom(source.platformKey)
  return (
    <Link
      href={`/buyer/sources/${source.id}`}
      className={cn(
        'group relative flex flex-col gap-2 rounded-xl border p-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'border-border bg-card hover:bg-muted/30',
        !source.isActive && 'opacity-70',
      )}
      aria-label={`Открыть учёт: ${source.name}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <PlatformLogo platform={platform} size={32} rounded="rounded-lg" />
          <span className="truncate text-sm font-semibold">{source.name}</span>
        </span>
        {source.finance.pendingCount > 0 ? (
          <Badge className="border-transparent bg-warning/15 text-warning">
            {source.finance.pendingCount} ждут
          </Badge>
        ) : !source.isActive ? (
          <Badge
            variant="outline"
            className="border-transparent bg-muted text-muted-foreground"
          >
            Выключен
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 text-sm">
        <Wallet className="size-3.5 text-muted-foreground" />
        <span
          className={cn(
            'font-semibold tabular-nums',
            source.finance.balance >= 0 ? 'text-success' : 'text-destructive',
          )}
        >
          {formatMoney(source.finance.balance, source.finance.currency)}
        </span>
        <span className="text-xs text-muted-foreground">баланс</span>
      </div>

      <div className="mt-1 flex items-center gap-4 text-sm">
        <span
          className="flex items-center gap-1.5"
          title="Написали сегодня"
        >
          <MessageSquare className="size-3.5 text-primary" />
          <span className="font-medium tabular-nums">
            {source.stats.todayTotal}
          </span>
        </span>
        <span
          className="flex items-center gap-1.5"
          title="Передано куратору сегодня"
        >
          <Send className="size-3.5 text-success" />
          <span className="font-medium tabular-nums">
            {source.stats.transferredToday}
          </span>
        </span>
      </div>
    </Link>
  )
}

export function BuyerOverview({
  initialSources,
}: {
  initialSources: BuyerSourceOverview[]
}) {
  const router = useRouter()
  // Источники приходят из RSC. НЕ кладём их в useState: после создания
  // источника мы вызываем router.refresh(), сервер отдаёт свежие props —
  // useState(initialX) заморозил бы первое значение, и новый источник не
  // появлялся бы до полной перезагрузки. Читаем props напрямую.
  const sources = initialSources
  const [addOpen, setAddOpen] = useState(false)

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Мои источники"
          description="Ваши источники трафика: бюджеты, баланс и дневной учёт."
        />
        <Button onClick={() => setAddOpen(true)} className="shrink-0">
          <Plus className="size-4" />
          Добавить источник
        </Button>
      </div>

      {sources.length === 0 ? (
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-center transition-colors hover:bg-muted/50"
        >
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Plus className="size-6" />
          </span>
          <span className="text-sm font-medium">Добавьте первый источник</span>
          <span className="max-w-sm text-xs text-muted-foreground">
            Выберите площадку из каталога, настройте учёт и ведите бюджет, траты
            и метрики в одном месте.
          </span>
        </button>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {sources.map((s) => (
            <SourceCard key={s.id} source={s} />
          ))}
        </div>
      )}

      <AddSourceModal
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => router.refresh()}
      />
    </div>
  )
}
