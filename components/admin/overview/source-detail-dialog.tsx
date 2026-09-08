'use client'

/**
 * Отчёт одного источника трафика для админа/руководителя. Открывается по клику
 * на карточку источника в «Обзоре» большим модальным окном на ~85% экрана.
 *
 * Смысловое разделение (по требованию):
 *   • «Написавшие» — это те, кто написал в источник (первичный трафик).
 *     В ЦЕНТРЕ — крупная панель динамики написавших с графиком за 14 дней
 *     и итогами (сегодня / всего / среднее в день).
 *   • «Передано» — это передачи куратору (не то же самое, что написавшие).
 *   • Ниже — drill-down: списки написавших и переданных за сегодня, с
 *     переключателем.
 *
 * Данные тянутся клиентски (SWR) через getSourceLeadReportAction — скоуп по
 * роли проверяется на сервере (админ — любой источник, руководитель — только
 * байеры своей команды).
 */

import { useState } from 'react'
import useSWR from 'swr'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  XAxis,
  YAxis,
} from 'recharts'
import {
  AtSign,
  Loader2,
  MapPin,
  MessageSquare,
  Phone,
  Send,
  TrendingUp,
  Users,
} from 'lucide-react'
import {
  getSourceLeadReportAction,
  type SourceOverviewRow,
} from '@/app/actions/source-finance'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import type { LeadCard } from '@/lib/data/lead-cards-core'
import { leadStatusLabel } from '@/lib/lead-status'
import { formatMskDateShort, formatMskDateTime } from '@/lib/time'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { cn } from '@/lib/utils'

type Segment = 'wrote' | 'transferred'

const chartConfig = {
  wrote: { label: 'Написавшие', color: 'var(--chart-1)' },
  transferred: { label: 'Передано', color: 'var(--chart-2)' },
} satisfies ChartConfig

/**
 * Управляемая обёртка: рендерит модалку, когда выбран источник (row != null).
 */
export function SourceDetailDialog({
  row,
  onOpenChange,
}: {
  row: SourceOverviewRow | null
  onOpenChange: (open: boolean) => void
  /** Совместимость с вызывающими; отчёт read-only, ничего не меняет. */
  onChanged?: () => void
}) {
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      {row ? (
        <DialogContent
          showCloseButton={false}
          className="flex h-[85vh] max-h-[85vh] w-[85vw] max-w-[85vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[85vw]"
        >
          <SourceDetailBody row={row} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function SourceDetailBody({ row }: { row: SourceOverviewRow }) {
  const { source, stats } = row
  const platform = platformOrCustom(source.platformKey)
  const [segment, setSegment] = useState<Segment>('wrote')

  const { data, isLoading } = useSWR(
    ['source-lead-report', source.id],
    () => getSourceLeadReportAction(source.id),
    { keepPreviousData: true, revalidateOnFocus: false },
  )

  // Мгновенные числа из stats карточки, пока грузится подробный отчёт.
  const wroteToday = data?.wroteToday.length ?? stats?.todayTotal ?? 0
  const transferredToday =
    data?.transferredToday.length ?? stats?.transferredToday ?? 0
  const totalWrote = data?.totalWrote ?? stats?.total ?? 0
  const totalTransferred = data?.totalTransferred ?? stats?.transferredTotal ?? 0

  const series = data?.dailySeries ?? []
  const wrote14 = series.reduce((s, d) => s + d.wrote, 0)
  const transferred14 = series.reduce((s, d) => s + d.transferred, 0)
  const avgWrote =
    series.length > 0 ? Math.round((wrote14 / series.length) * 10) / 10 : 0
  const peak = series.reduce((m, d) => Math.max(m, d.wrote), 0)
  // Коэффициент конверсии в передачу за окно графика.
  const convRate =
    wrote14 > 0 ? Math.round((transferred14 / wrote14) * 100) : 0

  const chartData = series.map((d) => ({
    day: formatMskDateShort(d.date),
    wrote: d.wrote,
    transferred: d.transferred,
  }))

  const leads =
    segment === 'wrote'
      ? (data?.wroteToday ?? [])
      : (data?.transferredToday ?? [])

  return (
    <>
      {/* Шапка: закреплена, не скроллится */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card/60 px-5 py-4">
        <PlatformLogo platform={platform} size={52} rounded="rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{source.name}</h2>
            {!source.isActive ? (
              <Badge
                variant="outline"
                className="border-transparent bg-muted text-muted-foreground"
              >
                Выключен
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {platform.name}
            {source.externalAccount ? ` · ${source.externalAccount}` : ''} ·
            владелец: {source.buyerName ?? 'без владельца'}
          </p>
        </div>
        <DialogClose render={<Button variant="outline" size="sm" />}>
          Закрыть
        </DialogClose>
      </header>

      {/* Тело: скроллится */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          {/* Компактная сводка сверху: написавшие и передачи разведены */}
          <section
            aria-label="Сводка источника"
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          >
            <MiniStat
              icon={MessageSquare}
              label="Написали сегодня"
              value={wroteToday}
              tone="primary"
            />
            <MiniStat
              icon={Users}
              label="Написали всего"
              value={totalWrote}
            />
            <MiniStat
              icon={Send}
              label="Передано сегодня"
              value={transferredToday}
              tone="success"
            />
            <MiniStat
              icon={Send}
              label="Передано всего"
              value={totalTransferred}
              tone="success"
            />
          </section>

          {/* ЦЕНТР: подробная панель написавших с графиком */}
          <Card className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <TrendingUp className="size-4 text-primary" />
                  Написавшие — динамика за 14 дней
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Первичный трафик источника по дням (МСК). Линия — передачи
                  куратору для сравнения.
                </p>
              </div>
              <div className="flex items-center gap-4 text-right">
                <SummaryNum label="За 14 дней" value={wrote14} />
                <SummaryNum label="Среднее/день" value={avgWrote} />
                <SummaryNum label="Пик за день" value={peak} />
                <SummaryNum label="Конверсия в передачу" value={`${convRate}%`} />
              </div>
            </div>

            {isLoading && !data ? (
              <div className="flex h-[280px] items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
                <span className="sr-only">Загрузка динамики источника</span>
              </div>
            ) : chartData.length === 0 ? (
              <p className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                Нет данных для графика.
              </p>
            ) : (
              <ChartContainer
                config={chartConfig}
                className="h-[280px] w-full"
              >
                <AreaChart
                  data={chartData}
                  margin={{ left: 4, right: 12, top: 8, bottom: 4 }}
                >
                  <defs>
                    <linearGradient id="fillWrote" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="5%"
                        stopColor="var(--color-wrote)"
                        stopOpacity={0.35}
                      />
                      <stop
                        offset="95%"
                        stopColor="var(--color-wrote)"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="day"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={16}
                    fontSize={11}
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                    fontSize={11}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area
                    dataKey="wrote"
                    type="monotone"
                    fill="url(#fillWrote)"
                    stroke="var(--color-wrote)"
                    strokeWidth={2}
                  />
                  <Line
                    dataKey="transferred"
                    type="monotone"
                    stroke="var(--color-transferred)"
                    strokeWidth={2}
                    dot={false}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </Card>

          {/* НИЖЕ: drill-down списки за сегодня с переключателем */}
          <Card className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Детализация за сегодня</h3>
              <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
                <SegBtn
                  active={segment === 'wrote'}
                  onClick={() => setSegment('wrote')}
                  icon={MessageSquare}
                  label={`Написали (${wroteToday})`}
                />
                <SegBtn
                  active={segment === 'transferred'}
                  onClick={() => setSegment('transferred')}
                  icon={Send}
                  label={`Передано (${transferredToday})`}
                />
              </div>
            </div>

            {isLoading && !data ? (
              <div className="flex h-40 items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
                <span className="sr-only">Загрузка списка лидов</span>
              </div>
            ) : leads.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                {segment === 'wrote'
                  ? 'Сегодня по этому источнику ещё никто не написал.'
                  : 'Сегодня по этому источнику ещё нет передач куратору.'}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {leads.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} segment={segment} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}

/* ------------------------------ Мини-плитка ------------------------------ */

function MiniStat({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: typeof MessageSquare
  label: string
  value: number
  tone?: 'default' | 'primary' | 'success'
}) {
  const toneCls = {
    default: 'text-foreground',
    primary: 'text-primary',
    success: 'text-success',
  }[tone]
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className={cn('size-3.5', tone === 'default' ? '' : toneCls)} />
        {label}
      </span>
      <span className={cn('text-2xl font-semibold tabular-nums', toneCls)}>
        {value}
      </span>
    </Card>
  )
}

/* --------------------------- Число в шапке графика --------------------------- */

function SummaryNum({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold tabular-nums leading-none">
        {value}
      </span>
      <span className="mt-1 text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

/* --------------------------- Переключатель сегмента --------------------------- */

function SegBtn({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof MessageSquare
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  )
}

/* ------------------------------ Строка лида ------------------------------ */

/** Контакт лида: @username → телефон → Telegram ID → «—». */
function leadContact(lead: LeadCard): { icon: typeof AtSign; text: string } {
  if (lead.telegramUsername) {
    return { icon: AtSign, text: lead.telegramUsername.replace(/^@/, '') }
  }
  if (lead.phone) return { icon: Phone, text: lead.phone }
  if (lead.telegramId) return { icon: AtSign, text: lead.telegramId }
  return { icon: AtSign, text: '—' }
}

function LeadRow({ lead, segment }: { lead: LeadCard; segment: Segment }) {
  const contact = leadContact(lead)
  const ContactIcon = contact.icon
  const when = segment === 'transferred' ? lead.transferredAt : lead.createdAt
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-background/40 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {lead.fullName || 'Без имени'}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ContactIcon className="size-3" />
            {contact.text}
          </span>
          {lead.city ? (
            <span className="flex items-center gap-1">
              <MapPin className="size-3" />
              {lead.city}
            </span>
          ) : null}
          {lead.curatorName && segment === 'transferred' ? (
            <span className="flex items-center gap-1">
              <Send className="size-3" />
              {lead.curatorName}
            </span>
          ) : null}
        </span>
      </span>
      {lead.status ? (
        <Badge variant="outline" className="shrink-0 text-xs">
          {leadStatusLabel(lead.status)}
        </Badge>
      ) : null}
      {when ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatMskDateTime(when)}
        </span>
      ) : null}
    </li>
  )
}
