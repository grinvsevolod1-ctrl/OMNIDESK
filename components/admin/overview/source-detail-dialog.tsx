'use client'

/**
 * Отчёт одного источника трафика для админа/руководителя. Открывается по клику
 * на карточку источника в «Обзоре» большим модальным окном на ~85% экрана.
 *
 * Смысловое разделение (по требованию владельца):
 *   • «Написали» — ВСЕ, кто реально написал (по диалогам с входящим, любого
 *     статуса), а не только заведённые вручную лид-карточки.
 *   • «Передано» — передачи куратору (lead_cards.transferred_at).
 *   • «В работе» — лиды в статусе working у кураторов (текущий снимок).
 *   • «Суточный расход» — деньги из дневного лога трат байера.
 *
 * Всё, кроме «в работе» (это снимок «сейчас»), считается за ВЫБРАННЫЙ период:
 * фильтр Сегодня / Вчера / 7 дней / 30 дней / Всё время. Переключение периода
 * рефетчит отчёт (SWR-ключ включает range) — цифры и списки скоупятся на
 * сервере. Скоуп по роли (админ — любой источник, руководитель — только байеры
 * своей команды) проверяет server action.
 */

import { useState } from 'react'
import useSWR from 'swr'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  XAxis,
  YAxis,
} from 'recharts'
import {
  AtSign,
  CalendarRange,
  Coins,
  Eye,
  Headset,
  Loader2,
  MapPin,
  MessageSquare,
  MousePointerClick,
  Phone,
  Send,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import {
  getSourceReportAction,
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
import type {
  SourceReportRange,
  SourceWriter,
} from '@/lib/data/traffic-sources'
import { LEAD_STATUS_TONE, leadStatusLabel } from '@/lib/lead-status'
import { formatMoney } from '@/lib/money'
import { formatMskDateShort, formatMskDateTime } from '@/lib/time'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { cn } from '@/lib/utils'

type Segment = 'wrote' | 'transferred' | 'working'

const RANGE_TABS: { key: SourceReportRange; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: 'week', label: '7 дней' },
  { key: 'month', label: '30 дней' },
  { key: 'all', label: 'Всё время' },
]

/** Сколько суток в периоде (для «среднее/день»); all — по факту записей. */
const RANGE_DAYS: Record<SourceReportRange, number | null> = {
  today: 1,
  yesterday: 1,
  week: 7,
  month: 30,
  all: null,
}

const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  telegram_personal: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

const trafficChartConfig = {
  wrote: { label: 'Написали', color: 'var(--chart-1)' },
  transferred: { label: 'Передано', color: 'var(--chart-2)' },
} satisfies ChartConfig

const spendChartConfig = {
  spend: { label: 'Расход', color: 'var(--chart-3)' },
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
          className="flex h-[88vh] max-h-[88vh] w-[88vw] max-w-[88vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[88vw]"
        >
          <SourceDetailBody row={row} />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function SourceDetailBody({ row }: { row: SourceOverviewRow }) {
  const { source } = row
  const platform = platformOrCustom(source.platformKey)
  const [range, setRange] = useState<SourceReportRange>('today')
  const [segment, setSegment] = useState<Segment>('wrote')

  const { data, isLoading } = useSWR(
    ['source-report', source.id, range],
    () => getSourceReportAction(source.id, range),
    { keepPreviousData: true, revalidateOnFocus: false },
  )

  const lead = data?.lead
  const spend = data?.spend
  const currency = spend?.currency ?? source.currency ?? 'RUB'
  const rangeLabel =
    RANGE_TABS.find((t) => t.key === range)?.label.toLowerCase() ?? ''
  const showAllTimeHint = range !== 'all'

  // Метрики за период.
  const wroteCount = lead?.counts.wrote ?? 0
  const transferredCount = lead?.counts.transferred ?? 0
  const workingCount = lead?.counts.working ?? 0
  const spendTotal = spend?.total ?? 0

  // Динамика 14 дней (для графика трафика).
  const series = lead?.dailySeries ?? []
  const wrote14 = series.reduce((s, d) => s + d.wrote, 0)
  const transferred14 = series.reduce((s, d) => s + d.transferred, 0)
  const avgWrote =
    series.length > 0 ? Math.round((wrote14 / series.length) * 10) / 10 : 0
  const peak = series.reduce((m, d) => Math.max(m, d.wrote), 0)
  const convRate =
    wrote14 > 0 ? Math.round((transferred14 / wrote14) * 100) : 0

  const trafficData = series.map((d) => ({
    day: formatMskDateShort(d.date),
    wrote: d.wrote,
    transferred: d.transferred,
  }))

  // Суточный расход.
  const spendDivisor = RANGE_DAYS[range] ?? Math.max(1, spend?.days.length ?? 1)
  const avgSpend = spendTotal / spendDivisor
  const spendLeads = spend?.leads ?? 0
  const cpl = spendLeads > 0 ? spendTotal / spendLeads : null
  const spendData = (spend?.daily ?? []).map((d) => ({
    day: formatMskDateShort(d.date),
    spend: d.spend,
  }))
  const hasSpendChart = (spend?.daily ?? []).some((d) => d.spend > 0)

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
        {isLoading && data ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : null}
        <DialogClose render={<Button variant="outline" size="sm" />}>
          Закрыть
        </DialogClose>
      </header>

      {/* Тело: скроллится */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-5">
          {/* Фильтр периода */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <CalendarRange className="size-4" />
              Период
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-1">
              {RANGE_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setRange(tab.key)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    range === tab.key
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Метрики за период */}
          <section
            aria-label="Показатели источника"
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          >
            <MiniStat
              icon={MessageSquare}
              label="Написали"
              value={wroteCount}
              tone="primary"
              hint={
                showAllTimeHint
                  ? `За всё время ${lead?.allTime.wrote ?? 0}`
                  : 'Все, кто написал'
              }
              loading={!lead}
            />
            <MiniStat
              icon={Send}
              label="Передано куратору"
              value={transferredCount}
              tone="success"
              hint={
                showAllTimeHint
                  ? `За всё время ${lead?.allTime.transferred ?? 0}`
                  : undefined
              }
              loading={!lead}
            />
            <MiniStat
              icon={Headset}
              label="В работе сейчас"
              value={workingCount}
              tone="info"
              hint="Текущий статус у кураторов"
              loading={!lead}
            />
            <MiniStat
              icon={Wallet}
              label="Расход"
              value={formatMoney(spendTotal, currency)}
              tone="warning"
              hint={
                showAllTimeHint
                  ? `За всё время ${formatMoney(spend?.allTime ?? 0, currency)}`
                  : undefined
              }
              loading={!spend}
            />
          </section>

          {/* Графики: трафик (2/3) + суточный расход (1/3) */}
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Динамика написавших/переданных за окно тренда (14/30/90 дней) */}
            <Card className="flex flex-col gap-4 p-5 lg:col-span-2">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <TrendingUp className="size-4 text-primary" />
                    Динамика за {series.length || 14} дней
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Написавшие (заливка) и переданные куратору (линия) по дням,
                    МСК.
                  </p>
                </div>
                <div className="flex items-center gap-4 text-right">
                  <SummaryNum label="Написали" value={wrote14} />
                  <SummaryNum label="Среднее/день" value={avgWrote} />
                  <SummaryNum label="Пик" value={peak} />
                  <SummaryNum label="Конверсия" value={`${convRate}%`} />
                </div>
              </div>

              {isLoading && !data ? (
                <ChartSkeleton />
              ) : trafficData.length === 0 ? (
                <ChartEmpty text="Нет данных для графика." />
              ) : (
                <ChartContainer
                  config={trafficChartConfig}
                  className="h-[260px] w-full"
                >
                  <AreaChart
                    data={trafficData}
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

            {/* Суточный расход */}
            <Card className="flex flex-col gap-4 p-5">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Coins className="size-4 text-warning" />
                  Суточный расход
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Траты байера за {rangeLabel}.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <SpendNum
                  label="Всего"
                  value={formatMoney(spendTotal, currency)}
                />
                <SpendNum
                  label="Среднее/день"
                  value={formatMoney(avgSpend, currency)}
                />
                <SpendNum
                  label="CPL"
                  value={cpl != null ? formatMoney(cpl, currency) : '—'}
                />
                <SpendNum label="Лиды (лог)" value={String(spendLeads)} />
              </div>

              {isLoading && !data ? (
                <div className="flex h-[120px] items-center justify-center">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : hasSpendChart ? (
                <ChartContainer
                  config={spendChartConfig}
                  className="h-[120px] w-full"
                >
                  <BarChart
                    data={spendData}
                    margin={{ left: 4, right: 4, top: 4, bottom: 0 }}
                  >
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="day"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={6}
                      minTickGap={24}
                      fontSize={10}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar
                      dataKey="spend"
                      fill="var(--color-spend)"
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              ) : (
                <p className="flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border text-center text-xs text-muted-foreground">
                  Байер ещё не вносил расход за последние дни.
                </p>
              )}

              <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Eye className="size-3.5" />
                  {(spend?.impressions ?? 0).toLocaleString('ru-RU')} показов
                </span>
                <span className="flex items-center gap-1">
                  <MousePointerClick className="size-3.5" />
                  {(spend?.clicks ?? 0).toLocaleString('ru-RU')} кликов
                </span>
              </div>
            </Card>
          </div>

          {/* Детализация с переключателем сегмента */}
          <Card className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                Детализация{' '}
                <span className="font-normal text-muted-foreground">
                  {segment === 'working' ? '(сейчас)' : `· ${rangeLabel}`}
                </span>
              </h3>
              <div className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-1">
                <SegBtn
                  active={segment === 'wrote'}
                  onClick={() => setSegment('wrote')}
                  icon={MessageSquare}
                  label={`Написали (${wroteCount})`}
                />
                <SegBtn
                  active={segment === 'transferred'}
                  onClick={() => setSegment('transferred')}
                  icon={Send}
                  label={`Передано (${transferredCount})`}
                />
                <SegBtn
                  active={segment === 'working'}
                  onClick={() => setSegment('working')}
                  icon={Headset}
                  label={`В работе (${workingCount})`}
                />
              </div>
            </div>

              <DetailList
                key={segment}
                segment={segment}
                lead={lead}
                loading={isLoading && !data}
              />
          </Card>
        </div>
      </div>
    </>
  )
}

/* ------------------------------ Детализация ------------------------------ */

function DetailList({
  segment,
  lead,
  loading,
}: {
  segment: Segment
  lead:
    | {
        writers: SourceWriter[]
        transferred: LeadCard[]
        working: LeadCard[]
      }
    | undefined
  loading: boolean
}) {
  // Списки могут быть длинными (сервер отдаёт до 300) — показываем порциями,
  // чтобы не рендерить сотни строк сразу. Сброс при смене вкладки обеспечивает
  // key={segment} у родителя (компонент перемонтируется).
  const PAGE = 25
  const [visible, setVisible] = useState(PAGE)

  if (loading || !lead) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Загрузка списка</span>
      </div>
    )
  }

  if (segment === 'wrote') {
    if (lead.writers.length === 0) {
      return <ListEmpty text="За выбранный период по этому источнику ещё никто не написал." />
    }
    return (
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {lead.writers.slice(0, visible).map((w) => (
            <WriterRow key={w.conversationId} writer={w} />
          ))}
        </ul>
        <ShowMore
          shown={Math.min(visible, lead.writers.length)}
          total={lead.writers.length}
          onMore={() => setVisible((v) => v + PAGE)}
        />
      </div>
    )
  }

  const leads = segment === 'transferred' ? lead.transferred : lead.working
  if (leads.length === 0) {
    return (
      <ListEmpty
        text={
          segment === 'transferred'
            ? 'За выбранный период передач куратору не было.'
            : 'Сейчас нет лидов в статусе «В работе».'
        }
      />
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {leads.slice(0, visible).map((l) => (
          <LeadRow key={l.id} lead={l} segment={segment} />
        ))}
      </ul>
      <ShowMore
        shown={Math.min(visible, leads.length)}
        total={leads.length}
        onMore={() => setVisible((v) => v + PAGE)}
      />
    </div>
  )
}

/** Кнопка «показать ещё» + счётчик «показано N из M». Скрыта, когда всё видно. */
function ShowMore({
  shown,
  total,
  onMore,
}: {
  shown: number
  total: number
  onMore: () => void
}) {
  if (shown >= total) {
    return total > 0 ? (
      <p className="text-center text-xs text-muted-foreground">
        Показаны все {total}
        {total >= 300 ? ' (максимум)' : ''}
      </p>
    ) : null
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button variant="outline" size="sm" onClick={onMore}>
        Показать ещё
      </Button>
      <span className="text-xs text-muted-foreground">
        Показано {shown} из {total}
      </span>
    </div>
  )
}

/* ------------------------------ Мини-плитка ------------------------------ */

function MiniStat({
  icon: Icon,
  label,
  value,
  tone = 'default',
  hint,
  loading,
}: {
  icon: typeof MessageSquare
  label: string
  value: number | string
  tone?: 'default' | 'primary' | 'success' | 'info' | 'warning'
  hint?: string
  loading?: boolean
}) {
  const toneCls = {
    default: 'text-foreground',
    primary: 'text-primary',
    success: 'text-success',
    info: 'text-sky-600 dark:text-sky-400',
    warning: 'text-warning',
  }[tone]
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className={cn('size-3.5', tone === 'default' ? '' : toneCls)} />
        {label}
      </span>
      {loading ? (
        <span className="h-8 w-16 animate-pulse rounded bg-muted" />
      ) : (
        <span className={cn('text-2xl font-semibold tabular-nums', toneCls)}>
          {value}
        </span>
      )}
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
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

function SpendNum({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
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

/* ------------------------------ Пустые состояния ------------------------------ */

function ChartSkeleton() {
  return (
    <div className="flex h-[260px] items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <span className="sr-only">Загрузка динамики источника</span>
    </div>
  )
}

function ChartEmpty({ text }: { text: string }) {
  return (
    <p className="flex h-[260px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
      {text}
    </p>
  )
}

function ListEmpty({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
      {text}
    </p>
  )
}

/* ------------------------------ Строка написавшего ------------------------------ */

function WriterRow({ writer }: { writer: SourceWriter }) {
  const handle = writer.handle?.replace(/^@/, '') || ''
  const channel = CHANNEL_LABEL[writer.channelType] ?? writer.channelType
  const tone = writer.leadStatus ? LEAD_STATUS_TONE[writer.leadStatus] : null
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-background/40 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {writer.name || 'Без имени'}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {handle ? (
            <span className="flex items-center gap-1">
              <AtSign className="size-3" />
              {handle}
            </span>
          ) : null}
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
            {channel}
          </span>
        </span>
      </span>
      {writer.leadStatus && tone ? (
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
            tone.bg,
            tone.text,
          )}
        >
          <span className={cn('size-1.5 rounded-full', tone.dot)} />
          {leadStatusLabel(writer.leadStatus)}
        </span>
      ) : (
        <Badge
          variant="outline"
          className="shrink-0 border-transparent bg-muted/60 text-[11px] text-muted-foreground"
        >
          Без карточки
        </Badge>
      )}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatMskDateTime(writer.wroteAt)}
      </span>
    </li>
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

function LeadRow({
  lead,
  segment,
}: {
  lead: LeadCard
  segment: Exclude<Segment, 'wrote'>
}) {
  const contact = leadContact(lead)
  const ContactIcon = contact.icon
  const when = segment === 'transferred' ? lead.transferredAt : lead.createdAt
  const tone = lead.status ? LEAD_STATUS_TONE[lead.status] : null
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
          {lead.curatorName ? (
            <span className="flex items-center gap-1">
              <Users className="size-3" />
              {lead.curatorName}
            </span>
          ) : null}
        </span>
      </span>
      {lead.status && tone ? (
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
            tone.bg,
            tone.text,
          )}
        >
          <span className={cn('size-1.5 rounded-full', tone.dot)} />
          {leadStatusLabel(lead.status)}
        </span>
      ) : (
        <Badge variant="outline" className="shrink-0 text-xs">
          {leadStatusLabel(lead.status)}
        </Badge>
      )}
      {when ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatMskDateTime(when)}
        </span>
      ) : null}
    </li>
  )
}
