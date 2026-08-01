import { ServersAdmin } from '@/components/admin/hosting/servers-admin'
import { PageHeader } from '@/components/page-parts'
import { requireAdmin } from '@/lib/auth'
import { listServers } from '@/lib/data'
import { isWorkerConfigured, workerHealth } from '@/lib/worker-client'

export default async function AdminServersPage() {
  await requireAdmin()
  const servers = await listServers()
  const workerOnline = isWorkerConfigured ? await workerHealth() : false

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Серверы"
        description="Управляйте парком VPS и разворачивайте на них приложения прямо из Git-репозиториев."
      />

      {!workerOnline ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          Воркер не в сети — серверы и приложения можно добавлять, но проверка
          связи, деплой и управление процессами требуют запущенного воркера на
          VPS.
        </p>
      ) : null}

      <ServersAdmin servers={servers} />
    </div>
  )
}
