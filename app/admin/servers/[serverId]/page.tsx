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
  const server = await getServerById(serverId)
  if (!server) notFound()
  const apps = await listAppsForServer(serverId)

  return <ServerDetail server={server} apps={apps} />
}
