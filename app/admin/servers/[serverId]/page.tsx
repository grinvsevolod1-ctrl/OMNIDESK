import { notFound } from 'next/navigation'
import { ServerDetail } from '@/components/admin/hosting/server-detail'
import { requireAdmin } from '@/lib/auth'
import { getServerById, listAppsForServer } from '@/lib/data'

export default async function AdminServerPage({
  params,
}: {
  params: Promise<{ serverId: string }>
}) {
  await requireAdmin()
  const { serverId } = await params
  // Independent by id — fetch in parallel, 404 after both settle.
  const [server, apps] = await Promise.all([
    getServerById(serverId),
    listAppsForServer(serverId),
  ])
  if (!server) notFound()

  return <ServerDetail server={server} apps={apps} />
}
