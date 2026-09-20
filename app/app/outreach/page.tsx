import { requireManager } from '@/lib/auth'
import { listLeadsForManager } from '@/lib/data/outreach-leads'
import { OutreachView } from '@/components/manager/outreach/outreach-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Исходящие — OMNIDESK',
  description: 'Очередь лидов и первое касание с прогретых аккаунтов',
}

export default async function OutreachPage() {
  const session = await requireManager()
  const initialLeads = await listLeadsForManager(session.sub)

  return <OutreachView initialLeads={initialLeads} />
}
