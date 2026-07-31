'use client'

import { useMemo, useState } from 'react'
import { ArrowUpDown, MessageSquareText, Trophy } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { ConversationReaderDialog } from '@/components/admin/dashboard/conversation-reader-dialog'
import type { ManagerPerformance } from '@/lib/data'

type SortKey =
  | 'totalLeads'
  | 'newThisWeek'
  | 'unanswered'
  | 'transferred'
  | 'clicks'
  | 'activity'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'totalLeads', label: 'Отписок' },
  { key: 'newThisWeek', label: 'Новые 7 дней' },
  { key: 'unanswered', label: 'Без ответа' },
  { key: 'transferred', label: 'Передан' },
  { key: 'clicks', label: 'Переходы' },
  { key: 'activity', label: 'Активность' },
]

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'нет активности'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.round(diff / 60000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const hrs = Math.round(min / 60)
  if (hrs < 24) return `${hrs} ч назад`
  const days = Math.round(hrs / 24)
  return `${days} дн назад`
}

function sortValue(m: ManagerPerformance, key: SortKey): number {
  switch (key) {
    case 'totalLeads':
      return m.totalLeads
    case 'newThisWeek':
      return m.newThisWeek
    case 'unanswered':
      return m.unanswered
    case 'transferred':
      return m.byStatus.transferred
    case 'clicks':
      return m.clicks
    case 'activity':
      return m.lastActivityAt ? new Date(m.lastActivityAt).getTime() : 0
  }
}

/** Proportional status bar (отписок / ликвид / не ликвид / передан). */
function StatusBar({ m }: { m: ManagerPerformance }) {
  const segments = [
    { v: m.byStatus.unsubscribed, c: 'bg-sky-500' },
    { v: m.byStatus.liquid, c: 'bg-teal-500' },
    { v: m.byStatus.not_liquid, c: 'bg-muted-foreground/60' },
    { v: m.byStatus.transferred, c: 'bg-emerald-500' },
  ]
  const total = segments.reduce((n, s) => n + s.v, 0)
  if (total === 0) {
    return <div className="h-1.5 w-full rounded-full bg-muted" />
  }
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {segments.map((s, i) =>
        s.v > 0 ? (
          <div
            key={i}
            className={s.c}
            style={{ width: `${(s.v / total) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  )
}

export function ManagerLeaderboard({
  managers,
}: {
  managers: ManagerPerformance[]
}) {
  const [sortKey, setSortKey] = useState<SortKey>('totalLeads')
  const [reader, setReader] = useState<{ id: string; name: string } | null>(
    null,
  )

  const sorted = useMemo(() => {
    return [...managers].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey))
  }, [managers, sortKey])

  const topId = sorted[0]?.totalLeads ? sorted[0].manager.id : null

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Trophy className="size-4 text-muted-foreground" />
          <h2 className="font-medium">Менеджеры</h2>
          <span className="text-xs text-muted-foreground">
            {managers.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ArrowUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSortKey(s.key)}
              className={cn(
                'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                sortKey === s.key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          Менеджеров пока нет. Создайте первого, чтобы начать.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {sorted.map((m) => (
            <li
              key={m.manager.id}
              className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center"
            >
              {/* Identity */}
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar className="size-9 shrink-0">
                  <AvatarFallback className="bg-secondary text-xs font-medium text-secondary-foreground">
                    {initials(m.manager.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-medium">
                      {m.manager.name}
                    </p>
                    {topId === m.manager.id ? (
                      <Trophy className="size-3.5 shrink-0 text-amber-500" />
                    ) : null}
                    {m.manager.status === 'blocked' ? (
                      <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                        Заблок.
                      </span>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {relativeTime(m.lastActivityAt)} ·{' '}
                    {m.connectedChannels}/{m.totalChannels} каналов
                  </p>
                  <div className="mt-1.5 max-w-[220px]">
                    <StatusBar m={m} />
                  </div>
                </div>
              </div>

              {/* Metrics — 2×2 on narrow phones so the two-word labels
                  («Без ответа») don't wrap into a cramped mess, one row from sm+. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-5">
                <Metric label="Отписок" value={m.totalLeads} />
                <Metric label="Новые" value={m.newThisWeek} />
                <Metric
                  label="Без ответа"
                  value={m.unanswered}
                  tone={m.unanswered > 0 ? 'warning' : 'default'}
                />
                <Metric
                  label="Передан"
                  value={m.byStatus.transferred}
                  tone="success"
                />
              </div>

              <div className="shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setReader({ id: m.manager.id, name: m.manager.name })
                  }
                >
                  <MessageSquareText className="size-4" />
                  <span className="hidden sm:inline">Читать чаты</span>
                  <span className="sm:hidden">Чаты</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConversationReaderDialog
        managerId={reader?.id ?? null}
        managerName={reader?.name ?? null}
        open={reader !== null}
        onOpenChange={(o) => {
          if (!o) setReader(null)
        }}
      />
    </Card>
  )
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: number
  tone?: 'default' | 'success' | 'warning'
}) {
  return (
    <div className="flex flex-col">
      <span
        className={cn(
          'text-base font-semibold tabular-nums',
          tone === 'success' && value > 0 && 'text-success',
          tone === 'warning' && value > 0 && 'text-warning',
        )}
      >
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}
