'use client'

import dynamic from 'next/dynamic'
import { Users } from 'lucide-react'
import { channelIcon } from '@/components/channel-icons'
import { useChannelTypeLabels } from '@/components/dictionaries-provider'
import { StatCard } from '@/components/page-parts'
import { Card } from '@/components/ui/card'
import type { GroupAnalytics } from '@/lib/data'
import type { PanelChannelType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { typeDot } from './shared'

// Rendered only once group analytics are fetched client-side, so defer the
// heavy canvas chart out of the admin overview's initial bundle. ssr:false —
// nothing to render before the client fetch resolves.
const ActivityChart = dynamic(
  () =>
    import('@/components/analytics/activity-chart').then((m) => m.ActivityChart),
  {
    ssr: false,
    loading: () => <div className="h-64 animate-pulse rounded-lg bg-muted/40" />,
  },
)

/** Fetched report: stat cards, activity chart and per-channel breakdown. */
export function Report({ analytics }: { analytics: GroupAnalytics }) {
  const TYPE_LABEL = useChannelTypeLabels()
  // Блоки по типам мессенджеров больше не захардкожены под Telegram/WhatsApp/
  // Онлайн-чат: строим их из фактических данных и сортируем по убыванию лидов.
  // «Всего написали» закреплён первым, дальше — три самых активных канала.
  const CHANNEL_TYPES: PanelChannelType[] = [
    'telegram',
    'whatsapp',
    'livechat',
    'max',
    'vk',
  ]
  const topTypes = CHANNEL_TYPES.map((type) => ({
    type,
    people: analytics.byType[type].people,
    messages: analytics.byType[type].messages,
  }))
    .sort((a, b) => b.people - a.people)
    .slice(0, 3)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Всего написали"
          value={analytics.totalPeople}
          icon={Users}
          hint={`${analytics.totalMessages} сообщений`}
        />
        {topTypes.map((t) => (
          <StatCard
            key={t.type}
            label={TYPE_LABEL[t.type]}
            value={t.people}
            icon={channelIcon(t.type)}
            hint={`${t.messages} сообщений`}
          />
        ))}
      </div>

      <ActivityChart byDay={analytics.byDay} byHour={analytics.byHour} />

      <ChannelTable analytics={analytics} />
    </div>
  )
}

function ChannelTable({ analytics }: { analytics: GroupAnalytics }) {
  const TYPE_LABEL = useChannelTypeLabels()
  // byChannel уже отсортирован сервером по убыванию людей. Доля считается от
  // самого активного канала, чтобы нарисовать сравнительную полоску.
  const peak = Math.max(1, ...analytics.byChannel.map((c) => c.people))

  return (
    <Card className="p-5">
      <h2 className="font-medium">Куда писали</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Разбивка обращений по каждому каналу источника — от самого активного.
      </p>
      {analytics.byChannel.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          В источнике нет каналов.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {analytics.byChannel.map((c) => {
            const Icon = channelIcon(c.type)
            const pct = Math.round((c.people / peak) * 100)
            return (
              <div
                key={c.channelId}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {/* Бренд-иконка без подложки: логотипы самодостаточны */}
                    <Icon className="size-8" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {TYPE_LABEL[c.type]}
                      </p>
                    </div>
                  </div>
                  <p className="shrink-0 text-2xl font-semibold tabular-nums">
                    {c.people}
                  </p>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn('h-full rounded-full', typeDot(c.type))}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{c.people} чел.</span>
                  <span>{c.messages} сообщений</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
