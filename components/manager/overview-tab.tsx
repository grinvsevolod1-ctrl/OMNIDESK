'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { getManagerChannelsOverviewAction } from '@/app/actions/manager-analytics'
import {
  PeriodPicker,
  resolvePeriod,
} from '@/components/admin/overview/period-picker'
import { DeltaBadge } from '@/components/admin/overview/delta-badge'
import { useManagerOverviewPrefs } from '@/components/admin/overview/use-overview-prefs'
import { ManagerActivityChart } from '@/components/analytics/manager-activity-chart'
import { ChannelsOverview } from '@/components/manager/channels-overview'

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

/** Ступень воронки — тот же вид, что в панели деталей Обзора админа. */
function FunnelStep({
  label,
  value,
  conversion,
  last,
  prev,
  href,
}: {
  label: string
  value: number
  conversion?: string
  last?: boolean
  prev?: number
  href?: string
}) {
  return (
    <div className="relative min-w-32 flex-1 rounded-lg border border-border bg-card p-3">
      <p className="flex items-baseline gap-1.5">
        {href ? (
          <Link
            href={href}
            className="text-2xl font-semibold tabular-nums underline-offset-4 hover:underline"
            title="Открыть входящие"
          >
            {value}
          </Link>
        ) : (
          <span className="text-2xl font-semibold tabular-nums">{value}</span>
        )}
        <DeltaBadge current={value} prev={prev} />
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {conversion ? (
        <p className="mt-1 text-[11px] font-medium text-primary/80">
          {conversion}
        </p>
      ) : null}
      {!last ? (
        <span
          className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 text-muted-foreground/50 sm:block"
          aria-hidden
        >
          →
        </span>
      ) : null}
    </div>
  )
}

/**
 * Обзор менеджера в стиле Обзора админа: ОДИН период сверху управляет всем
 * экраном — воронкой за период (с дельтами к прошлому периоду), сеткой
 * каналов и графиком активности. Финансов нет — они видны только админу.
 * Период и вид (карточки/список) запоминаются между заходами.
 */
export function ManagerOverviewTab() {
  const [prefs, updatePrefs] = useManagerOverviewPrefs()
  const [, setActiveId] = useState<string | null>(null)

  const resolved = useMemo(
    () => resolvePeriod(prefs.preset, prefs.customFrom, prefs.customTo),
    [prefs.preset, prefs.customFrom, prefs.customTo],
  )
  const fromISO = resolved.from.toISOString()
  const toISO = resolved.to.toISOString()

  const { data: payload, isLoading } = useSWR(
    ['manager-channels-overview', fromISO, toISO],
    async () => {
      const tz = new Date().getTimezoneOffset()
      const res = await getManagerChannelsOverviewAction(fromISO, toISO, tz)
      if (!res.ok || !res.data) throw new Error(res.message)
      return { overview: res.data, prev: res.prev, prevTotals: res.prevTotals }
    },
    { keepPreviousData: true },
  )

  const totals = payload?.overview.totals
  const prevTotals = payload?.prevTotals

  return (
    <div className="flex flex-col gap-5">
      {/* Единый период на весь экран — как в Обзоре админа */}
      <PeriodPicker
        preset={prefs.preset}
        customFrom={prefs.customFrom}
        customTo={prefs.customTo}
        resolved={resolved}
        onChange={(patch) => updatePrefs(patch)}
      />

      {/* Воронка за период: те же ступени и конверсии, что у админа */}
      <section aria-label="Воронка лидов">
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
          Воронка за период
        </h2>
        <div className="flex flex-wrap gap-3 sm:gap-5">
          <FunnelStep
            label="Написали"
            value={totals?.people ?? 0}
            prev={prevTotals?.people}
            href="/app/inbox"
          />
          <FunnelStep
            label="Взяли в работу"
            value={totals?.handoff ?? 0}
            conversion={pct(totals?.handoff ?? 0, totals?.people ?? 0)}
            prev={prevTotals?.handoff}
          />
          <FunnelStep
            label="Ликвид"
            value={totals?.liquid ?? 0}
            conversion={pct(totals?.liquid ?? 0, totals?.handoff ?? 0)}
            prev={prevTotals?.liquid}
          />
          <FunnelStep
            label="Передан"
            value={totals?.transferred ?? 0}
            conversion={pct(totals?.transferred ?? 0, totals?.liquid ?? 0)}
            prev={prevTotals?.transferred}
            last
          />
        </div>
      </section>

      {/* Сетка каналов — данные приходят сверху, период общий */}
      <ChannelsOverview
        items={payload?.overview.items ?? []}
        prev={payload?.prev}
        isLoading={isLoading}
        view={prefs.view}
        onViewChange={(view) => updatePrefs({ view })}
        onSelect={setActiveId}
      />

      {/* Активность по дням/часам — тот же период */}
      <ManagerActivityChart fromISO={fromISO} toISO={toISO} />
    </div>
  )
}
