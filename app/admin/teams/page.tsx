import { requireAdmin } from '@/lib/auth'
import { listTeamsAction } from '@/app/actions/teams'
import { TeamsManager } from '@/components/teams/teams-manager'

export default async function AdminTeamsPage() {
  await requireAdmin()
  const initial = await listTeamsAction()
  return <TeamsManager initial={initial} />
}
