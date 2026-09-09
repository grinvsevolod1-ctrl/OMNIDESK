'use client'

/**
 * Отчёт одного источника трафика для админа/руководителя. Открывается по клику
 * на карточку источника в «Обзоре» большим модальным окном на ~90% экрана.
 *
 * Смысловое разделение (по требованию владельца):
 *   • «Написали» — ВСЕ, кто реально написал (по диалогам с входящим, любого
 *     статуса), а не только заведённые вручную лид-карточки.
 *   • «Передано» — передачи куратору (lead_cards.transferred_at).
 *   • «В работе» — лиды в статусе working у кураторов (текущий снимок).
 *   • «Суточный расход» — деньги из дневного лога трат байера.
 *
 * Всё, кроме «в работе» (это снимок «сейчас»), считается за ВЫБРАННЫЙ период:
 * пресеты Сегодня / Вчера / 7 / 30 дней / Всё время ИЛИ произвольный диапазон
 * дат. Переключение периода рефетчит отчёт (SWR-ключ включает период) — цифры
 * и списки скоупятся на сервере. Скоуп по роли (админ — любой источник,
 * руководитель — только байеры своей команды) проверяет server action.
 *
 * Раскладка заполняет всю высоту модала: слева стопка графиков (трафик + расход),
 * справа — детализация во всю высоту со внутренним скроллом, чтобы не оставалось
 * пустого пространства.
 *
 * Презентационные части вынесены в соседние файлы: атомы (source-detail-atoms),
 * список детализации (source-detail-list), выбор дат (source-range-picker).
 */

import { useMemo, useState } from 'react'
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
  CalendarRange,
  Coins,
  Eye,
  Headset,
  Loader2,
  MessageSquare,
  MousePointerClick,
  Send,
  TrendingUp,
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
import { useRealtimeRefresh } from '@/lib/hooks/use-lead-events'
import type {
  SourceReportPeriod,
  SourceReportRange,
} from '@/lib/data/traffic-sources'
import { formatMoney } from '@/lib/money'
import { formatMskDateShort, mskDayKey } from '@/lib/time'
import { platformOrCustom } from '@/lib/traffic-source-catalog'
import { cn } from '@/lib/utils'
import {
  ChartEmpty,
  ChartSkeleton,
  MiniStat,
  SegBtn,
  SpendNum,
  SummaryNum,
  type Segment,
} from './source-detail-atoms'
import { DetailList } from './source-detail-list'
import { CustomRangePicker } from './source-range-picker'

const PRESET_TABS: { key: Exclude<SourceReportRange, 'custom'>; label: string }[] =
  [
    { key: 'today', label: 'Сегодня' },
    { key: 'yesterday', label: 'Вчера' },
    { key: 'week', label: '7 дней' },
    { key: 'month', label: '30 дней' },
    { key: 'all', label: 'Всё время' },
  ]

const trafficChartConfig = {
  wrote: { label: 'Написали', color: 'var(--chart-1)' },
  transferred: { label: 'Передано', color: 'var(--chart-2)' },
} satisfies ChartConfig

const spendChartConfig = {
  spend: { label: 'Расход', color: 'var(--chart-3)' },
} satisfies ChartConfig

/** Сдвиг МСК-дня (YYYY-MM-DD) на delta суток; полдень UTC исключает краевые TZ. */
function addDaysKey(key: string, delta: number): string {
  const d = new Date(`${key}T09:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return mskDayKey(d)
}

/** Число суток в диапазоне [from, to] включительно (для «среднее/день»). */
function spanDays(from: string, to: string): number {
  const a = new Date(`${from}T09:00:00Z`).getTime()
  const b = new Date(`${to}T09:00:00Z`).getTime()
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1)
}

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
          className="flex h-[90vh] max-h-[90vh] w-[92vw] max-w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[92vw]"
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

  const todayKey = useMemo(() => mskDayKey(new Date()), [])
  const [customFrom, setCustomFrom] = useState(() => addDaysKey(todayKey, -6))
  const [customTo, setCustomTo] = useState(todayKey)

  const period: SourceReportPeriod =
    range === 'custom' ? { range, from: customFrom, to: customTo } : { range }

  const { data, isLoading, mutate } = useSWR(
    [
      'source-report',
      source.id,
      range,
      range === 'custom' ? customFrom : '',
      range === 'custom' ? customTo : '',
    ],
    () => getSourceReportAction(source.id, period),
    { keepPreviousData: true, revalidateOnFocus: false },
  )

  // Живой отчёт, пока модал открыт: source-события этого источника (расход/
  // депозит) и любые lead-события (новый диалог/передача влияют на «написали/
  // передано») тихо перечитывают отчёт за текущий период. Лид-события не несут
  // sourceId, поэтому по источнику фильтруем только 'source'.
  useRealtimeRefresh({
    onRefresh: () => void mutate(),
    lead: true,
    source: true,
    sourceId: source.id,
  })

  const lead = data?.lead
  const spend = data?.spend
  const currency = spend?.currency ?? source.currency ?? 'RUB'
  const isCustom = range === 'custom'
  const rangeLabel = isCustom
    ? `${formatMskDateShort(customFrom)} — ${formatMskDateShort(customTo)}`
    : PRESET_TABS.find((t) => t.key === range)?.label.toLowerCase() ?? ''
  const showAllTimeHint = range !== 'all'

  // Метрики за период.
  const wroteCount = lead?.counts.wrote ?? 0
  const transferredCount = lead?.counts.transferred ?? 0
  const workingCount = lead?.counts.working ?? 0
  const spendTotal = spend?.total ?? 0

  // Динамика (окно графика следует за фильтром).
  const series = useMemo(() => lead?.dailySeries ?? [], [lead?.dailySeries])
  const wroteWindow = series.reduce((s, d) => s + d.wrote, 0)
  const transferredWindow = series.reduce((s, d) => s + d.transferred, 0)
  const avgWrote =
    series.length > 0 ? Math.round((wroteWindow / series.length) * 10) / 10 : 0
  const peak = series.reduce((m, d) => Math.max(m, d.wrote), 0)
  const convRate =
    wroteWindow > 0 ? Math.round((transferredWindow / wroteWindow) * 100) : 0

  const trafficData = useMemo(
    () =>
      series.map((d) => ({
        day: formatMskDateShort(d.date),
        wrote: d.wrote,
        transferred: d.transferred,
      })),
    [series],
  )

  // Суточный расход.
  const spendDivisor = isCustom
    ? spanDays(customFrom, customTo)
    : range === 'today' || range === 'yesterday'
      ? 1
      : range === 'week'
        ? 7
        : range === 'month'
          ? 30
          : Math.max(1, spend?.days.length ?? 1)
  const avgSpend = spendTotal / spendDivisor
  const spendLeads = spend?.leads ?? 0
  const cpl = spendLeads > 0 ? spendTotal / spendLeads : null
  const spendData = useMemo(
    () =>
      (spend?.daily ?? []).map((d) => ({
        day: formatMskDateShort(d.date),
        spend: d.spend,
      })),
    [spend?.daily],
  )
  const hasSpendChart = (spend?.daily ?? []).some((d) => d.spend > 0)

  return (
    <>
      {/* Шапка: закреплена, не скроллится */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card/60 px-5 py-4">
        <PlatformLogo platform={platform} size={48} rounded="rounded-xl" />
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

      {/* Тело: на десктопе заполняет высоту, на узких экранах — скроллится */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 lg:overflow-hidden">
        {/* Фильтр периода */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CalendarRange className="size-4" />
            Период
          </span>
          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/50 p-1">
            {PRESET_TABS.map((tab) => (
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
            <CustomRangePicker
              active={isCustom}
              from={customFrom}
              to={customTo}
              max={todayKey}
              label={isCustom ? rangeLabel : 'Даты'}
              onApply={(from, to) => {
                setCustomFrom(from)
                setCustomTo(to)
                setRange('custom')
              }}
            />
          </div>
        </div>

        {/* Метрики за период */}
        <section
          aria-label="Показатели источника"
          className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4"
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

        {/* Основная область: графики (слева) + детализация (справа), во всю высоту */}
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-5">
          {/* Левая колонка: трафик + расход */}
          <div className="flex min-h-0 flex-col gap-4 lg:col-span-3">
            {/* Динамика написавших/переданных */}
            <Card className="flex min-h-[280px] flex-col gap-3 p-5 lg:min-h-0 lg:flex-1">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <TrendingUp className="size-4 text-primary" />
                    Динамика{isCustom ? '' : ` за ${series.length || 14} дней`}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Написавшие (заливка) и переданные (линия) по дням, МСК.
                  </p>
                </div>
                <div className="flex items-center gap-4 text-right">
                  <SummaryNum label="Написали" value={wroteWindow} />
                  <SummaryNum label="Ср./день" value={avgWrote} />
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
                  className="min-h-[200px] w-full flex-1"
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
            <Card className="flex shrink-0 flex-col gap-3 p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Coins className="size-4 text-warning" />
                    Суточный расход
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Траты байера за {rangeLabel}.
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Eye className="size-3.5" />
                    {(spend?.impressions ?? 0).toLocaleString('ru-RU')}
                  </span>
                  <span className="flex items-center gap-1">
                    <MousePointerClick className="size-3.5" />
                    {(spend?.clicks ?? 0).toLocaleString('ru-RU')}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <SpendNum
                  label="Всего"
                  value={formatMoney(spendTotal, currency)}
                />
                <SpendNum
                  label="Ср./день"
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
                  Байер ещё не вносил расход за этот период.
                </p>
              )}
            </Card>
          </div>

          {/* Правая колонка: детализация во всю высоту со скроллом */}
          <Card className="flex min-h-[360px] flex-col gap-3 p-4 lg:col-span-2 lg:min-h-0">
            <div className="flex shrink-0 flex-col gap-2">
              <h3 className="text-sm font-semibold">
                Детализация{' '}
                <span className="font-normal text-muted-foreground">
                  {segment === 'working' ? '(сейчас)' : `· ${rangeLabel}`}
                </span>
              </h3>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1">
                <SegBtn
                  active={segment === 'wrote'}
                  onClick={() => setSegment('wrote')}
                  icon={MessageSquare}
                  label="Написали"
                  count={wroteCount}
                />
                <SegBtn
                  active={segment === 'transferred'}
                  onClick={() => setSegment('transferred')}
                  icon={Send}
                  label="Передано"
                  count={transferredCount}
                />
                <SegBtn
                  active={segment === 'working'}
                  onClick={() => setSegment('working')}
                  icon={Headset}
                  label="В работе"
                  count={workingCount}
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto max-lg:max-h-[420px]">
              <DetailList
                key={segment}
                segment={segment}
                lead={lead}
                loading={isLoading && !data}
              />
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
