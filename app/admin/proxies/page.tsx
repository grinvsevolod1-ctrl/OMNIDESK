import { ProxiesAdmin } from '@/components/admin/proxies-admin'
import { PageHeader } from '@/components/page-parts'
import { requireAdmin } from '@/lib/auth'
import {
  getProxyAnalytics,
  listAllProxies,
  listManagers,
  listManagersWithProxies,
} from '@/lib/data'
import { isWorkerConfigured, workerHealth } from '@/lib/worker-client'

export default async function AdminProxiesPage() {
  await requireAdmin()
  const [proxies, managers, analytics, managerSummaries] = await Promise.all([
    listAllProxies(),
    listManagers(),
    getProxyAnalytics(),
    listManagersWithProxies(),
  ])
  const workerOnline = isWorkerConfigured ? await workerHealth() : false

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Прокси"
        description="Добавляйте прокси-серверы в пул, назначайте их менеджерам и проверяйте работоспособность."
      />

      {!workerOnline ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          Воркер не в сети — прокси можно добавлять и назначать, но проверка
          «Тест» требует запущенного процесса воркера на VPS.
        </p>
      ) : null}

      <ProxiesAdmin
        proxies={proxies}
        managers={managers}
        analytics={analytics}
        managerSummaries={managerSummaries}
      />
    </div>
  )
}
