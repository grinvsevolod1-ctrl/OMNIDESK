import { ManagerLeadsView } from '@/components/manager/manager-leads-view'
import { PageHeader } from '@/components/page-parts'
import { requireManager } from '@/lib/auth'
import { getLeadCardStats, listLeadCardsForManager } from '@/lib/data/lead-stats'
import { mskDayKey } from '@/lib/time'

export const dynamic = 'force-dynamic'

/**
 * Manager «Мои лиды»: only this manager's lead cards with date/period/status
 * filters and per-period stats (created / transferred, today and any day).
 */
export default async function ManagerLeadsPage() {
  const session = await requireManager()

  // Initial window matches the client's default «7 дней» preset.
  const today = mskDayKey(new Date())
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 6)
  const from = mskDayKey(weekAgo)

  const [list, stats] = await Promise.all([
    listLeadCardsForManager(session.sub, { from, to: today, limit: 50 }),
    getLeadCardStats({ managerId: session.sub, from, to: today }),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Мои лиды"
        description="Карточки лидов, которые вы заполнили: статистика за сегодня, за период или за любой день, фильтр по статусам и передаче куратору."
      />
      <ManagerLeadsView
        initialLeads={list.leads}
        initialTotal={list.total}
        initialStats={stats}
      />
    </div>
  )
}
