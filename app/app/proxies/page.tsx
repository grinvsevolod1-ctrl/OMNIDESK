import { ProxiesManager } from '@/components/manager/proxies-manager'
import { PageHeader } from '@/components/page-parts'
import { requireManager } from '@/lib/auth'
import {
  listManagerAssignedProxies,
  listManagerOwnedProxies,
} from '@/lib/data'
import { isWorkerConfigured, workerHealth } from '@/lib/worker-client'

export default async function ManagerProxiesPage() {
  const session = await requireManager()
  const [owned, assigned] = await Promise.all([
    listManagerOwnedProxies(session.sub),
    listManagerAssignedProxies(session.sub),
  ])
  const workerOnline = isWorkerConfigured ? await workerHealth() : false

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Прокси"
        description="Добавляйте и управляйте своими прокси, проверяйте связь и используйте назначенные администратором прокси при подключении аккаунтов."
      />

      {!workerOnline ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          Worker офлайн — прокси можно добавлять и удалять, но проверка связи
          «Проверить» требует запущенного worker-процесса.
        </p>
      ) : null}

      <ProxiesManager owned={owned} assigned={assigned} />
    </div>
  )
}
