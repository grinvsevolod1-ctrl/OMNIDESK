'use client'

/**
 * Вкладка «Лиды» медиабайера: все лиды его источников с единым поиском
 * (username/телефон/город/регион/ФИО/дата), фильтрами по источнику и
 * статусу, сортировкой и постраничной навигацией. Всё read-only.
 *
 * Пагинация — клиентская: список лидов байера уже загружен целиком (это
 * его собственный трафик, объём умеренный), поэтому фильтрация, поиск и
 * переключение страниц происходят мгновенно без обращений к серверу.
 */

import { memo, useMemo, useState } from 'react'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  FileSpreadsheet,
  ListFilter,
  Search,
  User,
  X,
} from 'lucide-react'
import type { BuyerSourceOverview } from '@/app/actions/buyer'
import { exportBuyerLeadsExcelAction } from '@/app/actions/leads-export'
import { LeadsPagination } from '@/components/admin/leads/leads-pagination'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { useXlsxExport } from '@/components/shared/use-xlsx-export'
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
import { formatMskDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50

/** Строка лида: имя · @username/телефон · город (регион) · менеджер · дата · статус. */
const BuyerLeadRow = memo(function BuyerLeadRow({ lead }: { lead: LeadCard }) {
  const contact =
    [lead.telegramUsername ? `@${lead.telegramUsername}` : null, lead.phone]
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
        {lead.region ? <span className="opacity-70"> ({lead.region})</span> : null}
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

export function BuyerLeads({
  sources,
  leads,
}: {
  sources: BuyerSourceOverview[]
  leads: LeadCard[]
}) {
  const [sourceFilter, setSourceFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [offset, setOffset] = useState(0)
  const { exporting, runExport } = useXlsxExport()

  // Любое изменение фильтра/поиска/сортировки возвращает на первую страницу.
  // Делаем это в обработчиках (а не в эффекте) — без каскадных ре-рендеров.
  const changeSource = (v: string) => {
    setSourceFilter(v)
    setOffset(0)
  }
  const changeStatus = (v: string) => {
    setStatusFilter(v)
    setOffset(0)
  }
  const changeSearch = (v: string) => {
    setSearch(v)
    setOffset(0)
  }
  const toggleSort = () => {
    setSort((s) => (s === 'newest' ? 'oldest' : 'newest'))
    setOffset(0)
  }

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

  // Страховка: если список сократился (обновились props leads), а offset
  // указывает за его пределы — «схлопываем» к первой странице при рендере.
  const safeOffset = offset >= filtered.length ? 0 : offset
  const page = filtered.slice(safeOffset, safeOffset + PAGE_SIZE)
  const hasFilter = Boolean(search || statusFilter || sourceFilter)

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title="Лиды"
        description="Все лиды по вашим источникам с поиском и фильтрами."
      />

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={sourceFilter}
          onValueChange={(v) => changeSource((v as string) ?? '')}
        >
          <SelectTrigger
            className="h-9 max-w-56 gap-2 font-medium"
            aria-label="Фильтр по источнику"
          >
            <ListFilter className="size-4 shrink-0 text-muted-foreground" />
            <SelectValue placeholder="Все источники" />
          </SelectTrigger>
          <SelectContent className="w-auto min-w-52">
            <SelectItem value="">Все источники</SelectItem>
            {sources.map((s) => {
              const platform = platformOrCustom(s.platformKey)
              return (
                <SelectItem key={s.id} value={s.id}>
                  <span className="flex items-center gap-2">
                    <PlatformLogo
                      platform={platform}
                      size={16}
                      rounded="rounded"
                    />
                    {s.name}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>

        <Select
          value={statusFilter}
          onValueChange={(v) => changeStatus((v as string) ?? '')}
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
            onChange={(e) => changeSearch(e.target.value)}
            placeholder="@username, телефон, город, регион, дата…"
            className="h-9 pl-8 pr-8"
            aria-label="Единый поиск по лидам"
          />
          {search ? (
            <button
              type="button"
              onClick={() => changeSearch('')}
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
          onClick={toggleSort}
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

      {/* Список */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={User}
          title={hasFilter ? 'Ничего не найдено' : 'Пока нет лидов'}
          description={
            hasFilter
              ? 'Попробуйте изменить фильтры или запрос поиска.'
              : 'Когда по вашим источникам придут лиды, они появятся здесь.'
          }
        />
      ) : (
        <>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {page.map((lead) => (
                <BuyerLeadRow key={lead.id} lead={lead} />
              ))}
            </ul>
          </Card>

          {filtered.length > PAGE_SIZE ? (
            <LeadsPagination
              total={filtered.length}
              offset={safeOffset}
              pageSize={PAGE_SIZE}
              pending={false}
              onPage={(o) => {
                setOffset(o)
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }}
            />
          ) : null}
        </>
      )}
    </div>
  )
}
