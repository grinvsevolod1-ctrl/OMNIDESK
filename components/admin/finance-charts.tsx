'use client'

import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import type { FinanceAdAccount } from '@/lib/finance-types'

const MONTHS_RU = [
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
]

interface TrendPoint {
  key: string
  label: string
  leads: number
  clicks: number
}

/**
 * Aggregate ad stats into monthly buckets. Leads and clicks are unit-less,
 * so they are safe to sum across accounts and currencies.
 */
function buildMonthlyTrend(accounts: FinanceAdAccount[]): TrendPoint[] {
  const map = new Map<string, TrendPoint>()
  for (const account of accounts) {
    for (const st of account.stats) {
      const d = new Date(st.periodStart + 'T00:00:00')
      if (Number.isNaN(d.getTime())) continue
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const label = `${MONTHS_RU[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`
      const point = map.get(key) ?? { key, label, leads: 0, clicks: 0 }
      point.leads += st.leads
      point.clicks += st.clicks
      map.set(key, point)
    }
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(-12)
}

const chartConfig: ChartConfig = {
  clicks: { label: 'Клики', color: 'var(--chart-3)' },
  leads: { label: 'Лиды', color: 'var(--success)' },
}

export function AdsTrendChart({ accounts }: { accounts: FinanceAdAccount[] }) {
  const data = useMemo(() => buildMonthlyTrend(accounts), [accounts])

  if (data.length < 2) return null

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
      <AreaChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="fillLeads" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-leads)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--color-leads)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.4} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={12}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={36}
          fontSize={12}
          allowDecimals={false}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Area
          dataKey="leads"
          type="monotone"
          fill="url(#fillLeads)"
          stroke="var(--color-leads)"
          strokeWidth={2}
        />
        <Line
          dataKey="clicks"
          type="monotone"
          stroke="var(--color-clicks)"
          strokeWidth={2}
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
