import Link from 'next/link'
import { CheckCheck, Inbox, MessageCircle, Plug, Plus, Users } from 'lucide-react'
import { channelIcon, type BrandIconComponent } from '@/components/channel-icons'
import { ManagerActivityChart } from '@/components/analytics/manager-activity-chart'
import { LeadStatusBoard } from '@/components/manager/lead-status-board'
import {
  EmptyState,
  PageHeader,
  StatCard,
  StatusBadge,
} from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { requireManager } from '@/lib/auth'
import { getLeadAnalytics, getManagerStats, listChannels } from '@/lib/data'
import { getChannelMeta, type ChannelType } from '@/lib/types'



export default async function ManagerOverviewPage() {
  const session = await requireManager()
  const [stats, channels, leads] = await Promise.all([
    getManagerStats(session.sub),
    listChannels(session.sub),
    getLeadAnalytics(session.sub),
  ])
  const firstName = session.name.split(' ')[0]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`С возвращением, ${firstName}`}
        description="Аналитика по вашим лидам: новые обращения, статусы и каналы."
        action={
          <Button
            render={
              <Link href="/app/inbox">
                <Inbox className="size-4" />
                Открыть входящие
              </Link>
            }
          />
        }
      />

      {/* Lead KPIs — scoped to this manager, each lead counted once by first contact */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Лиды</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Отписок"
            value={leads.totalLeads}
            icon={Users}
            hint="всего написало людей"
          />
          <StatCard
            label="Новых за 7 дней"
            value={leads.newThisWeek}
            icon={Inbox}
            hint="первое обращение"
          />
          <StatCard
            label="Ликвид"
            value={leads.byStatus.liquid}
            icon={MessageCircle}
            hint="подходящая аудитория"
          />
          <StatCard
            label="Передан"
            value={leads.byStatus.transferred}
            icon={CheckCheck}
            hint="подошёл и передан"
          />
        </div>
      </section>

      {/* Interactive activity chart (manager-scoped, with period controls) */}
      <ManagerActivityChart />

      {/* Interactive lead-status board with drill-down modal */}
      <LeadStatusBoard
        byStatus={leads.byStatus}
        byReason={leads.byReason}
        total={leads.totalLeads}
      />

      {/* Channels */}
      <Card>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <h2 className="font-medium">Ваши каналы</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {stats.connectedChannels}/{stats.totalChannels} подключено
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            render={<Link href="/app/connections">Управление</Link>}
          />
        </div>
        {channels.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={Plug}
              title="Каналов пока нет"
              description="Подключите Telegram, WhatsApp или виджет живого чата на сайте, чтобы начать получать сообщения."
              action={
                <Button
                  render={
                    <Link href="/app/connections">
                      <Plus className="size-4" />
                      Добавить первый канал
                    </Link>
                  }
                />
              }
            />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {channels.map((c) => {
              const Icon = channelIcon(c.type)
              return (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {getChannelMeta(c.type).label} · {c.detail}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={c.status} />
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
