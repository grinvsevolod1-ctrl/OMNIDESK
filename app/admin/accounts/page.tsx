import { PageHeader } from '@/components/page-parts'
import { AccountsAdmin } from '@/components/admin/accounts-admin'
import { requireAdmin } from '@/lib/auth'
import { listAdminChannels, listAllProxies, listManagers } from '@/lib/data'
import { isWorkerConfigured, workerHealth } from '@/lib/worker-client'

export default async function AdminAccountsPage() {
  await requireAdmin()
  const [channels, proxies, managers] = await Promise.all([
    listAdminChannels(),
    listAllProxies(),
    listManagers(),
  ])
  const workerOnline = isWorkerConfigured ? await workerHealth() : false

  // A proxy is "free" for a given type when no account of that type already uses
  // it. We expose the raw usage map to the client so the create form can filter
  // the proxy dropdown per selected channel type in real time.
  const proxyUsage: Record<string, string[]> = {}
  for (const c of channels) {
    if (!c.proxyId) continue
    ;(proxyUsage[c.proxyId] ??= []).push(c.type)
  }

  const legacyNoProxy = channels.filter((c) => !c.proxyId).length

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Аккаунты"
        description="Централизованное подключение и управление аккаунтами Telegram, WhatsApp, VK и MAX. Каждому аккаунту обязательно назначается прокси — один прокси обслуживает не более одного аккаунта каждого типа."
      />

      {!isWorkerConfigured ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          Воркер не настроен — задайте WORKER_SECRET и WORKER_URL, затем
          запустите процесс воркера на VPS. Без него недоступен вход в Telegram
          (VK и MAX подключаются без воркера).
        </p>
      ) : !workerOnline ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          Воркер не в сети — Telegram-вход требует запущенного процесса воркера
          на VPS (проверьте pm2). VK и MAX подключаются без воркера.
        </p>
      ) : null}

      {legacyNoProxy > 0 ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          {legacyNoProxy === 1
            ? 'Один аккаунт'
            : `${legacyNoProxy} аккаунта(-ов)`}{' '}
          подключены без прокси (создано до нового правила). Назначьте им прокси,
          чтобы весь трафик шёл через выделенный IP.
        </p>
      ) : null}

      <AccountsAdmin
        channels={channels}
        proxies={proxies}
        managers={managers}
        proxyUsage={proxyUsage}
        workerOnline={workerOnline}
      />
    </div>
  )
}
