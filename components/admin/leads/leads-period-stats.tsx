'use client'

import { memo } from 'react'
import { ArrowRightLeft, CalendarDays, UserPlus, Users } from 'lucide-react'
import { StatCard } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import type { LeadCardStats } from '@/lib/data/lead-stats'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
} from '@/lib/lead-status'
import { cn } from '@/lib/utils'

/** Карточки статистики за выбранный период + разбивка по статусам. */
export const LeadsPeriodStats = memo(function LeadsPeriodStats({
  stats,
  today,
}: {
  stats: LeadCardStats
  today: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Карточек создано"
          value={stats.created}
          icon={UserPlus}
          hint={
            stats.from === stats.to
              ? `за ${stats.from === today ? 'сегодня' : stats.from}`
              : `${stats.from} — ${stats.to}`
          }
        />
        <StatCard
          label="Передано менеджеру по кадрам"
          value={stats.transferred}
          icon={ArrowRightLeft}
          hint="за выбранный период"
        />
        <StatCard
          label="Создано сегодня"
          value={stats.createdToday}
          icon={CalendarDays}
          hint="независимо от периода"
        />
        <StatCard
          label="Передано сегодня"
          value={stats.transferredToday}
          icon={Users}
          hint="независимо от периода"
        />
      </div>
      {Object.keys(stats.byStatus).length > 0 || stats.noStatus > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {LEAD_STATUSES.filter((s) => (stats.byStatus[s] ?? 0) > 0).map(
            (s) => {
              const tone = LEAD_STATUS_TONE[s]
              return (
                <Badge
                  key={s}
                  variant="outline"
                  className={cn(
                    'gap-1.5 border-transparent',
                    tone.bg,
                    tone.text,
                  )}
                >
                  <span className={cn('size-1.5 rounded-full', tone.dot)} />
                  {LEAD_STATUS_LABELS[s]}: {stats.byStatus[s]}
                </Badge>
              )
            },
          )}
          {stats.noStatus > 0 ? (
            <Badge
              variant="outline"
              className="border-transparent bg-muted text-muted-foreground"
            >
              Без статуса: {stats.noStatus}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
