import { ServersConsole } from '@/components/admin/servers-console/servers-console'
import { PageHeader } from '@/components/page-parts'
import { requireAdmin } from '@/lib/auth'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import { listServers } from '@/lib/data'
import { isWorkerConfigured, workerHealthCached } from '@/lib/worker-client'

export const dynamic = 'force-dynamic'

export default async function AdminServersPage() {
  await requireAdmin()
  // Independent lookups — run in parallel (health probe is TTL-cached).
  const [servers, workerOnline] = await Promise.all([
    listServers(),
    isWorkerConfigured ? workerHealthCached() : Promise.resolve(false),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Серверы"
        description="Разговорная консоль: подключите VPS и скажите, какой репозиторий развернуть — ИИ сам всё установит и покажет живой лог."
      />
      <ServersConsole
        initialServers={servers}
        configured={isBrainConfigured()}
        workerOnline={workerOnline}
      />
    </div>
  )
}
