import Link from 'next/link'
import { Inbox } from 'lucide-react'
import { LeadStatusBoard } from '@/components/manager/lead-status-board'
import { ManagerOverviewTab } from '@/components/manager/overview-tab'
import { PageHeader } from '@/components/page-parts'
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
        description="Единый период сверху управляет всем обзором: воронка, каналы и активность."
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

      {/* Обзор в стиле админа: один период → воронка + каналы + активность */}
      <ManagerOverviewTab />

      {/* Доска статусов лидов за всё время с drill-down (менеджерская фишка) */}
      <LeadStatusBoard
        byStatus={leads.byStatus}
        byReason={leads.byReason}
        total={leads.totalLeads}
      />
    </div>
  )
}
