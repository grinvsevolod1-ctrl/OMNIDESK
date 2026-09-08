'use client'

/**
 * Главный экран «Обзор» админа/руководителя: ВСЕ источники трафика единым
 * списком. Это ровно тот же traffic_sources, что создаёт байер в своём разделе
 * и что видно в «Медиабайерах» — созданный байером источник появляется здесь
 * сразу, без зеркал и синхронизации (единая сущность). Экран read-only:
 * источники создаёт и настраивает только байер.
 */
import { useMemo, useState } from 'react'
import { Link as LinkIcon, Megaphone, Moon, Search, Sun, Wallet } from 'lucide-react'
import Link from 'next/link'
import type { SourceOverviewRow } from '@/app/actions/source-finance'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { MoneyStack } from '@/components/money'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatMoney } from '@/lib/money'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { cn } from '@/lib/utils'

const ALL = '__all__'

/** Минуты от полуночи → «ЧЧ:ММ» (окно дня источника в МСК). */
function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60)
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Свести суммы по валютам для итоговой плашки (валюты не смешиваем). */
function sumByCurrency(
  rows: SourceOverviewRow[],
  pick: (r: SourceOverviewRow) => number,
): { currency: string; amount: number }[] {
  const map = new Map<string, number>()
  for (const r of rows) {
    if (!r.summary) continue
    map.set(r.summary.currency, (map.get(r.summary.currency) ?? 0) + pick(r))
  }
  return [...map.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency))
}

function SummaryStat({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </Card>
  )
}

function SourceCard({ row }: { row: SourceOverviewRow }) {
  const { source, summary, stats } = row
  const platform = platformOrCustom(source.platformKey)
  return (
    <Card
      className={cn(
        'flex flex-col gap-3 p-4 transition-colors hover:border-foreground/20',
        !source.isActive && 'opacity-70',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2.5">
          <PlatformLogo platform={platform} size={36} rounded="rounded-lg" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">
              {source.name}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {platform.name}
            </span>
          </span>
        </span>
        {!source.isActive ? (
          <Badge
            variant="outline"
            className="shrink-0 border-transparent bg-muted text-muted-foreground"
          >
            Выключен
          </Badge>
        ) : summary && summary.pendingCount > 0 ? (
          <Badge className="shrink-0 border-transparent bg-warning/15 text-warning">
            {summary.pendingCount} ждут
          </Badge>
        ) : null}
      </div>

      {/* Владелец-байер — источник ведёт один медиабайер. */}
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Megaphone className="size-3.5 shrink-0" />
        <span className="truncate">
          {source.buyerName ?? 'Без владельца'}
        </span>
      </span>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-muted/40 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Баланс
          </p>
          <p
            className={cn(
              'text-sm font-semibold tabular-nums',
              summary && summary.balance < 0
                ? 'text-destructive'
                : 'text-success',
            )}
          >
            {summary
              ? formatMoney(summary.balance, summary.currency)
              : '—'}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Потрачено
          </p>
          <p className="text-sm font-semibold tabular-nums">
            {summary ? formatMoney(summary.totalSpend, summary.currency) : '—'}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Лиды
          </p>
          <p className="text-sm font-semibold tabular-nums">
            {source.leadCount}
          </p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        День {fmtMinutes(source.dayStart)}–{fmtMinutes(source.dayEnd)} · долёты{' '}
        {fmtMinutes(source.dayEnd)}–{fmtMinutes(source.dayStart)}
      </p>

      <div className="flex items-center gap-4 text-sm">
        <span
          className="flex items-center gap-1.5"
          title="Сегодня в дневном окне"
        >
          <Sun className="size-3.5 text-amber-500" />
          <span className="font-medium tabular-nums">
            {stats?.todayDay ?? 0}
          </span>
        </span>
        <span className="flex items-center gap-1.5" title="Сегодня «долёты»">
          <Moon className="size-3.5 text-sky-500" />
          <span className="font-medium tabular-nums">
            {stats?.todayNight ?? 0}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Wallet className="size-3.5" />
          {source.managerCount} менедж.
        </span>
      </div>
    </Card>
  )
}

export function SourcesOverview({
  initial,
}: {
  initial: SourceOverviewRow[]
}) {
  const [search, setSearch] = useState('')
  const [buyer, setBuyer] = useState(ALL)
  const [platform, setPlatform] = useState(ALL)
  const [activeOnly, setActiveOnly] = useState(false)

  const buyerOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const { source } of initial) {
      if (source.buyerId) map.set(source.buyerId, source.buyerName ?? '—')
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [initial])

  const platformOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const { source } of initial) {
      map.set(source.platformKey, platformOrCustom(source.platformKey).name)
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [initial])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return initial.filter(({ source }) => {
      if (activeOnly && !source.isActive) return false
      if (buyer !== ALL && source.buyerId !== buyer) return false
      if (platform !== ALL && source.platformKey !== platform) return false
      if (q) {
        const hay = `${source.name} ${source.buyerName ?? ''} ${source.externalAccount}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [initial, search, buyer, platform, activeOnly])

  const totalLeads = filtered.reduce((s, r) => s + r.source.leadCount, 0)
  const activeCount = filtered.filter((r) => r.source.isActive).length
  const balances = sumByCurrency(filtered, (r) => r.summary?.balance ?? 0)
  const spend = sumByCurrency(filtered, (r) => r.summary?.totalSpend ?? 0)

  return (
    <div className="flex flex-col gap-4">
      {/* Итоги по отфильтрованному срезу — валюты не смешиваются */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryStat label="Источники">
          <p className="text-2xl font-semibold tabular-nums">
            {filtered.length}
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">
              из них {activeCount} активн.
            </span>
          </p>
        </SummaryStat>
        <SummaryStat label="Лиды">
          <p className="text-2xl font-semibold tabular-nums">{totalLeads}</p>
        </SummaryStat>
        <SummaryStat label="Баланс">
          <MoneyStack
            items={balances}
            signedTone
            className="text-lg font-semibold"
          />
        </SummaryStat>
        <SummaryStat label="Потрачено">
          <MoneyStack items={spend} className="text-lg font-semibold" />
        </SummaryStat>
      </div>

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию, байеру, кабинету"
            className="h-9 pl-8"
          />
        </div>
        <Select value={buyer} onValueChange={(v) => setBuyer(v ?? ALL)}>
          <SelectTrigger className="h-9 w-[11rem]">
            <SelectValue placeholder="Байер" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Все байеры</SelectItem>
            {buyerOptions.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={platform} onValueChange={(v) => setPlatform(v ?? ALL)}>
          <SelectTrigger className="h-9 w-[11rem]">
            <SelectValue placeholder="Площадка" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Все площадки</SelectItem>
            {platformOptions.map(([key, name]) => (
              <SelectItem key={key} value={key}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={() => setActiveOnly((v) => !v)}
          aria-pressed={activeOnly}
          className={cn(
            'h-9 rounded-md border px-3 text-sm transition-colors',
            activeOnly
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:bg-muted',
          )}
        >
          Только активные
        </button>
      </div>

      {/* Сетка источников */}
      {initial.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Источников пока нет"
          description="Источники создают медиабайеры в своём разделе. Создайте медиабайера в разделе «Медиабайеры» — добавленные им источники появятся здесь автоматически."
          action={
            <Link
              href="/admin/buyers"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <LinkIcon className="size-4" /> Перейти к медиабайерам
            </Link>
          }
        />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          Ничего не найдено по заданным фильтрам.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((row) => (
            <SourceCard key={row.source.id} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}
