'use client'

/**
 * Обзор медиабайера: карточки его источников со статистикой «день/долёты»
 * (окна берутся из настроек КАЖДОГО источника) + все лиды его источников
 * с единым поиском по username/телефону/городу/региону/дате, фильтрами по
 * источнику и статусу и сортировкой. Всё read-only: байер видит свой
 * трафик, но не редактирует карточки.
 */

import { memo, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  FileSpreadsheet,
  ListFilter,
  Moon,
  Plus,
  Search,
  Sun,
  User,
  Wallet,
  X,
} from 'lucide-react'
import type { BuyerSourceOverview } from '@/app/actions/buyer'
import { exportBuyerLeadsExcelAction } from '@/app/actions/leads-export'
import { useXlsxExport } from '@/components/shared/use-xlsx-export'
import { AddSourceModal } from '@/components/buyer/add-source-modal'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { LeadCard } from '@/lib/data/lead-cards'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
} from '@/lib/lead-status'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { formatMoney } from '@/lib/money'
import { formatMskDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

const PAGE = 50

/** Минуты от полуночи → «ЧЧ:ММ». */
function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/**
 * Карточка источника: логотип площадки, имя, баланс, окно дня и счётчики
 * сегодня. Вся карточка — ссылка на детальный учёт; отдельный чип-фильтр
 * фильтрует список лидов, не переходя на страницу.
 */
function SourceCard({
  source,
  active,
  onToggle,
}: {
  source: BuyerSourceOverview
  active: boolean
  onToggle: () => void
}) {
  const platform = platformOrCustom(source.platformKey)
  return (
    <div
      className={cn(
        'group relative flex flex-col gap-2 rounded-xl border p-4 transition-colors',
        active
          ? 'border-primary bg-primary/10'
          : 'border-border bg-card hover:bg-muted/30',
      )}
    >
      <Link
        href={`/buyer/sources/${source.id}`}
        className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Открыть учёт: ${source.name}`}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <PlatformLogo platform={platform} size={32} rounded="rounded-lg" />
          <span className="truncate text-sm font-semibold">{source.name}</span>
        </span>
        {source.finance.pendingCount > 0 ? (
          <Badge className="relative z-10 border-transparent bg-warning/15 text-warning">
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

      <p className="text-xs text-muted-foreground">
        День {fmtMinutes(source.dayStart)}–{fmtMinutes(source.dayEnd)} · долёты{' '}
        {fmtMinutes(source.dayEnd)}–{fmtMinutes(source.dayStart)}
      </p>
      <div className="mt-1 flex items-center gap-4 text-sm">
        <span className="flex items-center gap-1.5" title="Сегодня в дневном окне">
          <Sun className="size-3.5 text-amber-500" />
          <span className="font-medium tabular-nums">
            {source.stats.todayDay}
          </span>
        </span>
        <span className="flex items-center gap-1.5" title="Сегодня «долёты»">
          <Moon className="size-3.5 text-sky-500" />
          <span className="font-medium tabular-nums">
            {source.stats.todayNight}
          </span>
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={active}
          className="relative z-10 ml-auto rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {active ? 'Сбросить фильтр' : 'Фильтр лидов'}
        </button>
      </div>
    </div>
  )
}

/** Строка лида: имя · @username/телефон · город (регион) · менеджер · дата · статус. */
const BuyerLeadRow = memo(function BuyerLeadRow({ lead }: { lead: LeadCard }) {
  const contact =
    [
      lead.telegramUsername ? `@${lead.telegramUsername}` : null,
      lead.phone,
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-x-4 px-4 py-2.5',
        'sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_7.5rem]',
        'md:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,8rem)_7.5rem]',
        'lg:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,8rem)_8.5rem_7.5rem]',
        '[content-visibility:auto] [contain-intrinsic-size:auto_3.5rem]',
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">
          {lead.fullName || 'Без имени'}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {contact}
        </span>
      </span>
      <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
        {lead.city || '—'}
        {lead.region ? (
          <span className="opacity-70"> ({lead.region})</span>
        ) : null}
      </span>
      <span className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
        {lead.managerName || '—'}
      </span>
      <span className="hidden text-xs tabular-nums text-muted-foreground lg:block">
        {formatMskDateTime(lead.createdAt)}
      </span>
      <span className="flex justify-end">
            <LeadStatusBadge
              status={lead.status}
              previousStatus={lead.previousStatus}
              at={lead.statusConfirmedAt}
            />
      </span>
    </li>
  )
})

export function BuyerOverview({
  initialSources,
  initialLeads,
}: {
  initialSources: BuyerSourceOverview[]
  initialLeads: LeadCard[]
}) {
  const router = useRouter()
  // Источники и лиды приходят из RSC. НЕ кладём их в useState: после создания
  // источника мы вызываем router.refresh(), сервер отдаёт свежие props — а
  // useState(initialX) заморозил бы первое значение, и новый источник не
  // появлялся бы до полной перезагрузки (это и был баг «источники не
  // появились у байера»). Читаем props напрямую — refresh сразу их обновляет.
  const sources = initialSources
  const leads = initialLeads
  const [addOpen, setAddOpen] = useState(false)

  const [sourceFilter, setSourceFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [visible, setVisible] = useState(PAGE)
  const { exporting, runExport } = useXlsxExport()

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = leads
    if (sourceFilter) out = out.filter((l) => l.trafficSourceId === sourceFilter)
    if (statusFilter === 'none') out = out.filter((l) => !l.status)
    else if (statusFilter) out = out.filter((l) => l.status === statusFilter)
    if (q) {
      // Единый поиск: username, телефон, город, регион, ФИО и дата (дд.мм.гггг).
      out = out.filter((l) => {
        const date = formatMskDateTime(l.createdAt).toLowerCase()
        return [
          l.fullName,
          l.phone,
          l.telegramUsername,
          l.city,
          l.region,
          date,
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      })
    }
    const key = (l: LeadCard) => new Date(l.createdAt).getTime()
    return [...out].sort((a, b) =>
      sort === 'newest' ? key(b) - key(a) : key(a) - key(b),
    )
  }, [leads, sourceFilter, statusFilter, search, sort])
  const shown = filtered.slice(0, visible)

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Мои источники"
          description="Ваши источники трафика: бюджеты, баланс, дневной учёт и все лиды."
        />
        <Button onClick={() => setAddOpen(true)} className="shrink-0">
          <Plus className="size-4" />
          Добавить источник
        </Button>
      </div>

      {/* Источники: карточка ведёт в учёт, чип фильтрует лиды */}
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
            <SourceCard
              key={s.id}
              source={s}
              active={sourceFilter === s.id}
              onToggle={() =>
                setSourceFilter((cur) => (cur === s.id ? '' : s.id))
              }
            />
          ))}
        </div>
      )}

      <AddSourceModal
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => router.refresh()}
      />

      {/* Фильтры лидов */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter((v as string) ?? '')}
        >
          <SelectTrigger
            className="h-9 max-w-52 gap-2 font-medium"
            aria-label="Фильтр по статусу"
          >
            <ListFilter className="size-4 shrink-0 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-auto min-w-44">
            <SelectItem value="">Все статусы</SelectItem>
            <SelectItem value="none">Без статуса</SelectItem>
            {LEAD_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      LEAD_STATUS_TONE[s].dot,
                    )}
                  />
                  {LEAD_STATUS_LABELS[s]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative min-w-0 flex-1 basis-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="@username, телефон, город, регион, дата…"
            className="h-9 pl-8 pr-8"
            aria-label="Единый поиск по лидам"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Очистить поиск"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => setSort((s) => (s === 'newest' ? 'oldest' : 'newest'))}
          aria-label="Переключить сортировку"
        >
          {sort === 'newest' ? (
            <ArrowDownWideNarrow className="size-4 shrink-0" />
          ) : (
            <ArrowUpNarrowWide className="size-4 shrink-0" />
          )}
          {sort === 'newest' ? 'Новые' : 'Старые'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="h-9"
          disabled={exporting || leads.length === 0}
          onClick={() => runExport(exportBuyerLeadsExcelAction)}
        >
          <FileSpreadsheet className="size-4 shrink-0" />
          {exporting ? 'Выгружаем…' : 'Excel'}
        </Button>
      </div>

      {/* Лиды */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={User}
          title={
            search || statusFilter || sourceFilter
              ? 'Ничего не найдено'
              : 'Пока нет лидов'
          }
          description={
            search || statusFilter || sourceFilter
              ? 'Попробуйте изменить фильтры или запрос поиска.'
              : 'Когда по вашим источникам придут лиды, они появятся здесь.'
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {shown.map((lead) => (
              <BuyerLeadRow key={lead.id} lead={lead} />
            ))}
          </ul>
        </Card>
      )}

      {filtered.length > visible ? (
        <button
          type="button"
          onClick={() => setVisible((v) => v + PAGE)}
          className="rounded-xl border border-border py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/40"
        >
          Показать ещё ({filtered.length - visible})
        </button>
      ) : null}
    </div>
  )
}
