import { SourcesOverview } from '@/components/admin/overview/sources-overview'
import { PageHeader } from '@/components/page-parts'
import { Card } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth'
import { checkDbConnection } from '@/lib/db'
import { getWorkerHealth } from '@/lib/data/worker-health'
import { listSourcesOverviewAction } from '@/app/actions/source-finance'

export const dynamic = 'force-dynamic'

export default async function AdminOverviewPage() {
  await requireAdmin()

  const [{ sources }, db, worker] = await Promise.all([
    listSourcesOverviewAction(),
    checkDbConnection(),
    getWorkerHealth(),
  ])

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

      <PageHeader
        title="Обзор"
        description="Все источники трафика единым списком: их ведут медиабайеры, а созданный байером источник появляется здесь сразу. Настройка и создание — на стороне байера."
      />

      <SourcesOverview initial={sources} />
    </div>
  )
}
