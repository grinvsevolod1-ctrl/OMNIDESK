import Link from 'next/link'
import { CheckCheck, Inbox, MessageCircle, Users } from 'lucide-react'
import { ManagerActivityChart } from '@/components/analytics/manager-activity-chart'
import { ChannelsOverview } from '@/components/manager/channels-overview'
import { LeadStatusBoard } from '@/components/manager/lead-status-board'
import { PageHeader, StatCard } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { requireManager } from '@/lib/auth'
import { getLeadAnalytics } from '@/lib/data'

export default async function ManagerOverviewPage() {
  const session = await requireManager()
  const leads = await getLeadAnalytics(session.sub)
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

      {/* Обзор каналов: трафик за период, вид карточки/список (запоминается) */}
      <ChannelsOverview />
    </div>
  )
}
