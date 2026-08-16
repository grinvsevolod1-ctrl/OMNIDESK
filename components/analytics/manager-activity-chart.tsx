'use client'

import dynamic from 'next/dynamic'
import { Loader2 } from 'lucide-react'
import useSWR from 'swr'
import { getManagerActivityAnalyticsAction } from '@/app/actions/manager-analytics'
// Large canvas chart whose data is fetched client-side after mount; keep it out
// of the manager home's initial bundle and load it lazily. ssr:false since
// there's nothing meaningful to render before the client fetch resolves.
const ActivityChart = dynamic(
  () =>
    import('@/components/analytics/activity-chart').then((m) => m.ActivityChart),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse rounded-lg bg-muted/40" />,
  },
)
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * График активности обращений менеджера. Контролируемый компонент: период
 * приходит сверху — им управляет единый PeriodPicker Обзора (как у админа),
 * собственных контролов периода здесь больше нет.
 */
export function ManagerActivityChart({
  fromISO,
  toISO,
}: {
  fromISO: string
  toISO: string
}) {
  const { data: analytics, isValidating } = useSWR(
    ['manager-activity', fromISO, toISO],
    async () => {
      // Часовой пояс менеджера знает браузер; сервер раскладывает дни по нему,
      // чтобы «сегодня» совпадало с локальными сутками, а не с UTC сервера.
      const tz = new Date().getTimezoneOffset()
      const res = await getManagerActivityAnalyticsAction(fromISO, toISO, tz)
      if (!res.ok || !res.data) throw new Error(res.message)
      return res.data
    },
    { keepPreviousData: true },
  )

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground">
        Активность обращений
      </h2>

      {!analytics ? (
        <Card className="flex h-64 items-center justify-center p-5">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <span className="sr-only">Загрузка графика активности</span>
        </Card>
      ) : (
        <div className={cn(isValidating && 'opacity-60 transition-opacity')}>
          <ActivityChart
            byDay={analytics.byDay}
            byHour={analytics.byHour}
            title="Ваши обращения по дням"
            hourTitle="Ваши обращения за день"
          />
        </div>
      )}
    </section>
  )
}
