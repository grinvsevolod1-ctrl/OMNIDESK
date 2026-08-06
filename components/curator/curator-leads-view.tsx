'use client'

import { useCallback, useMemo, useState } from 'react'
import { MapPin, User } from 'lucide-react'
import { LeadDetailPanel } from '@/components/curator/lead-detail-panel'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { StatusReminder } from '@/components/curator/status-reminder'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type { LeadCard } from '@/lib/data/lead-cards'
import {
  DAILY_STATUS_DEADLINE_HOUR,
  isPastDailyDeadline,
  needsDailyStatusUpdate,
} from '@/lib/lead-status'
import { APP_TIME_ZONE } from '@/lib/time'
import { cn } from '@/lib/utils'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

export function CuratorLeadsView({
  initialLeads,
}: {
  initialLeads: LeadCard[]
}) {
  const [leads, setLeads] = useState(initialLeads)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const pending = useMemo(
    () => leads.filter((l) => needsDailyStatusUpdate(l.statusConfirmedDate)),
    [leads],
  )
  const locked = isPastDailyDeadline() && pending.length > 0

  const refresh = useCallback(async () => {
    // Soft refresh via full navigation is heavy; re-fetch through list action.
    const { listMyCuratorLeadsAction } = await import('@/app/actions/lead-cards')
    const next = await listMyCuratorLeadsAction()
    setLeads(next)
  }, [])

  return (
    <div className="relative mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <StatusReminder leads={leads} />

      <PageHeader
        title="Мои лиды"
        description="Лиды, переданные вам менеджерами. Статусы нужно подтверждать каждый день."
      />

      {pending.length > 0 ? (
        <div
          className={cn(
            'rounded-xl border px-4 py-3 text-sm',
            locked
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          {locked ? (
            <>
              <p className="font-medium">
                Рабочее место ограничено до обновления статусов
              </p>
              <p className="mt-1 text-xs opacity-90">
                После {DAILY_STATUS_DEADLINE_HOUR}:00 (МСК) необходимо подтвердить
                статус каждого лида с комментарием. Осталось: {pending.length}.
                Уведомления будут повторяться каждые 20 минут.
              </p>
            </>
          ) : (
            <p>
              Есть лиды без статуса — лучше заполнить до {DAILY_STATUS_DEADLINE_HOUR}:00
              МСК ({pending.length}).
            </p>
          )}
        </div>
      ) : null}

      {leads.length === 0 ? (
        <EmptyState
          icon={User}
          title="Пока нет лидов"
          description="Когда менеджер заполнит карточку и передаст лид по вашему городу, он появится здесь."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {leads.map((lead) => {
            const needs = needsDailyStatusUpdate(lead.statusConfirmedDate)
            return (
              <Card
                key={lead.id}
                className={cn(
                  'cursor-pointer p-4 transition-colors hover:bg-muted/30',
                  needs && 'ring-1 ring-amber-500/30',
                )}
                onClick={() => setSelectedId(lead.id)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      {lead.fullName || 'Без имени'}
                    </p>
                    {lead.vacancy ? (
                      <p className="truncate text-sm text-muted-foreground">
                        {lead.vacancy}
                      </p>
                    ) : null}
                  </div>
                  {lead.city ? (
                    <Badge
                      variant="outline"
                      className="shrink-0 gap-1 border-transparent bg-muted text-muted-foreground"
                    >
                      <MapPin className="size-3" />
                      {lead.city}
                    </Badge>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <LeadStatusBadge
                    status={lead.status}
                    needsUpdate={needs}
                    previousStatus={lead.previousStatus}
                  />
                  {lead.transferredAt ? (
                    <span className="text-xs text-muted-foreground">
                      с {formatDateTime(lead.transferredAt)}
                    </span>
                  ) : null}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {selectedId ? (
        <LeadDetailPanel
          leadId={selectedId}
          onClose={() => setSelectedId(null)}
          onUpdated={() => void refresh()}
        />
      ) : null}

      {/* Hard lock overlay: only status updates are allowed via the detail panel */}
      {locked && !selectedId ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 border-t border-amber-500/30 bg-amber-500/95 px-4 py-3 text-center text-sm font-medium text-amber-950 shadow-lg">
          Обновите статусы всех лидов — нажмите на карточку, чтобы начать
        </div>
      ) : null}
    </div>
  )
}
