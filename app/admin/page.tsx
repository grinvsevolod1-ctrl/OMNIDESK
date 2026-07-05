import { ManagerLeaderboard } from '@/components/admin/dashboard/manager-leaderboard'
import { SourceGroupsOverview } from '@/components/admin/dashboard/source-groups-overview'
import { Card } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth'
import { checkDbConnection } from '@/lib/db'
import {
  getManagerPerformance,
  listAllChannels,
  listSourceGroups,
} from '@/lib/data'

export default async function AdminOverviewPage() {
  await requireAdmin()

  const [groups, channels, performance, db] = await Promise.all([
    listSourceGroups(),
    listAllChannels(),
    getManagerPerformance(),
    checkDbConnection(),
  ])

  const initialGroupId = groups[0]?.id ?? null

  const channelOptions = channels.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    detail: c.detail,
  }))

  return (
    <div className="flex flex-col gap-6">
      {!db.ok ? (
        <Card className="border-warning/30 bg-warning/5 p-4 text-sm text-warning">
          {db.message}
        </Card>
      ) : null}

      <SourceGroupsOverview
        groups={groups}
        channels={channelOptions}
        initialGroupId={initialGroupId}
      />

      {/* Manager control stays at the bottom, as before. */}
      <ManagerLeaderboard managers={performance} />
    </div>
  )
}
