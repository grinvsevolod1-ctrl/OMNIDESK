import { OverviewTab } from '@/components/admin/overview/overview-tab'
import { Card } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth'
import { checkDbConnection } from '@/lib/db'
import { getSourcesOverview } from '@/lib/data/sources'
import { getWorkerHealth } from '@/lib/data/worker-health'
import { listAllChannels, listSourceGroups } from '@/lib/data'

export default async function AdminOverviewPage() {
  await requireAdmin()

  // Начальный период — 7 дней. Клиент дальше сам меняет период через SWR.
  const to = new Date()
  to.setHours(24, 0, 0, 0)
  const from = new Date(to)
  from.setDate(to.getDate() - 7)

  const [overview, groups, channels, db, worker] = await Promise.all([
    getSourcesOverview(from.toISOString(), to.toISOString(), 0),
    listSourceGroups(),
    listAllChannels(),
    checkDbConnection(),
    getWorkerHealth(),
  ])

  const channelOptions = channels.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    detail: c.detail,
  }))

  return (
    <div className="flex flex-col gap-4">
      {!db.ok ? (
        <Card className="border-warning/30 bg-warning/5 p-4 text-sm text-warning">
          {db.message}
        </Card>
      ) : null}

      {worker.status === 'down' ? (
        <Card className="border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {worker.staleMinutes != null
            ? `Воркер каналов не отвечает уже ${worker.staleMinutes} мин — Telegram, VK и MAX не обрабатываются. Проверьте процесс на VPS: pm2 status, pm2 logs.`
            : 'Воркер каналов ещё ни разу не вышел на связь — Telegram, VK и MAX не обрабатываются. Проверьте, что процесс запущен: pm2 status.'}
        </Card>
      ) : null}

      <OverviewTab
        initialOverview={overview}
        groups={groups}
        channels={channelOptions}
      />
    </div>
  )
}
