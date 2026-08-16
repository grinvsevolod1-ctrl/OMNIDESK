import { notFound } from 'next/navigation'
import { AppDetail } from '@/components/admin/hosting/app-detail'
import { requireAdmin } from '@/lib/auth'
import {
  getAppById,
  getServerById,
  listDeploymentsForApp,
} from '@/lib/data'

export default async function AdminAppPage({
  params,
}: {
  params: Promise<{ serverId: string; appId: string }>
}) {
  await requireAdmin()
  const { serverId, appId } = await params
  const [server, app] = await Promise.all([
    getServerById(serverId),
    getAppById(appId),
  ])
  if (!server || !app || app.serverId !== serverId) notFound()
  const deployments = await listDeploymentsForApp(appId)

  return <AppDetail server={server} app={app} deployments={deployments} />
}
