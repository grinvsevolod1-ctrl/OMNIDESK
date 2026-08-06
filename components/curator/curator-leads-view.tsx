'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { Archive, MapPin, User } from 'lucide-react'
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
  leadNeedsDailyStatus,
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
  // Minute tick so the 10:00 MSK deadline kicks in live, without a reload.
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const pending = useMemo(
    () => leads.filter((l) => leadNeedsDailyStatus(l)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-evaluates the deadline
    [leads, tick],
  )
  const locked = isPastDailyDeadline() && pending.length > 0

  // Render in chunks so hundreds of leads don't weigh the page down.
  // Leads that still need today's confirmation always come first.
  const PAGE = 50
  const [visible, setVisible] = useState(PAGE)
  const ordered = useMemo(() => {
    const needs = (l: LeadCard) => leadNeedsDailyStatus(l)
    return [...leads].sort((a, b) => Number(needs(b)) - Number(needs(a)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-evaluates the deadline
  }, [leads, tick])
  const shown = ordered.slice(0, visible)

  // «Активные / Архив» tabs. The archive loads lazily on first open.
  const [tab, setTab] = useState<'active' | 'archive'>('active')
  const { data: archived, mutate: reloadArchive } = useSWR(
    tab === 'archive' ? 'curator-archived-leads' : null,
    async () => {
      const { listMyArchivedLeadsAction } = await import(
        '@/app/actions/lead-cards'
      )
      return listMyArchivedLeadsAction()
    },
    { revalidateOnFocus: false },
  )

  const refresh = useCallback(async () => {
    // Soft refresh via full navigation is heavy; re-fetch through list action.
    const { listMyCuratorLeadsAction } = await import('@/app/actions/lead-cards')
    const next = await listMyCuratorLeadsAction()
    setLeads(next)
    void reloadArchive()
  }, [reloadArchive])

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

      <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/30 p-1 self-start">
        <button
          type="button"
          onClick={() => setTab('active')}
          className={cn(
            'rounded-lg px-3 py-1.5 text-sm transition-colors',
            tab === 'active'
              ? 'bg-background font-medium shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Активные ({leads.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('archive')}
          className={cn(
            'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
            tab === 'archive'
              ? 'bg-background font-medium shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Archive className="size-3.5" />
          Архив
        </button>
      </div>

      {tab === 'archive' ? (
        !archived || archived.length === 0 ? (
          <EmptyState
            icon={Archive}
            title="Архив пуст"
            description="Сюда попадают лиды с финальным статусом («Отказался», «Кинул») — вручную или автоматически."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {archived.map((lead) => (
              <Card
                key={lead.id}
                className="cursor-pointer p-4 opacity-70 transition-opacity hover:opacity-100"
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
                    needsUpdate={false}
                    previousStatus={lead.previousStatus}
                  />
                  {lead.archivedAt ? (
                    <span className="text-xs text-muted-foreground">
                      в архиве с {formatDateTime(lead.archivedAt)}
                    </span>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )
      ) : leads.length === 0 ? (
        <EmptyState
          icon={User}
          title="Пока нет лидов"
          description="Когда менеджер заполнит карточку и передаст лид по вашему городу, он появится здесь."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((lead) => {
            const needs = leadNeedsDailyStatus(lead)
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

          {ordered.length > visible ? (
            <button
              type="button"
              onClick={() => setVisible((v) => v + PAGE)}
              className="rounded-xl border border-border py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/40"
            >
              Показать ещё ({ordered.length - visible})
            </button>
          ) : null}
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
