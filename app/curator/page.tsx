import { requireCurator } from '@/lib/auth'
import { listLeadCardsForCurator } from '@/lib/data/lead-cards'
import { CuratorLeadsView } from '@/components/curator/curator-leads-view'

export default async function CuratorLeadsPage() {
  const user = await requireCurator()
  const leads = await listLeadCardsForCurator(user.sub)

  return <CuratorLeadsView initialLeads={leads} />
}
