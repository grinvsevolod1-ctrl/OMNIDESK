import { requireHead } from '@/lib/auth'
import { listTeamsAction } from '@/app/actions/teams'
import { TeamsManager } from '@/components/teams/teams-manager'

export default async function HeadTeamPage() {
  await requireHead()
  const initial = await listTeamsAction()
  return <TeamsManager initial={initial} />
}
