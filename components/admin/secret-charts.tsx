'use client'

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

const TYPE_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

const trendConfig: ChartConfig = {
  incoming: { label: 'Входящие', color: 'var(--chart-2)' },
  outgoing: { label: 'Исходящие', color: 'var(--success)' },
}

const typeConfig: ChartConfig = {
  count: { label: 'Каналы', color: 'var(--chart-3)' },
}

export function MessagesTrendChart({
  data,
}: {
  data: { day: string; label: string; incoming: number; outgoing: number }[]
}) {
  return (
    <ChartContainer config={trendConfig} className="aspect-auto h-[220px] w-full">
      <AreaChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="fillIncoming" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-incoming)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--color-incoming)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="fillOutgoing" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-outgoing)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--color-outgoing)" stopOpacity={0} />
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
          width={32}
          fontSize={12}
          allowDecimals={false}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Area
          dataKey="incoming"
          type="monotone"
          fill="url(#fillIncoming)"
          stroke="var(--color-incoming)"
          strokeWidth={2}
        />
        <Area
          dataKey="outgoing"
          type="monotone"
          fill="url(#fillOutgoing)"
          stroke="var(--color-outgoing)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}

export function ChannelsTypeChart({
  data,
}: {
  data: { type: string; count: number }[]
}) {
  const rows = data.map((d) => ({ ...d, label: TYPE_LABEL[d.type] ?? d.type }))
  return (
    <ChartContainer config={typeConfig} className="aspect-auto h-[220px] w-full">
      <BarChart data={rows} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
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
          width={32}
          fontSize={12}
          allowDecimals={false}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} />
      </BarChart>
    </ChartContainer>
  )
}
