import { Users } from 'lucide-react'
import { CreateManagerDialog } from '@/components/admin/create-manager-dialog'
import { ManagerActions } from '@/components/admin/manager-actions'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { listChannels, listManagers } from '@/lib/data'
import { APP_TIME_ZONE } from '@/lib/time'
import type { Manager } from '@/lib/types'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: APP_TIME_ZONE,
  })
}

function pluralChannels(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'канал'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'канала'
  return 'каналов'
}

async function ManagerRowMeta({ id }: { id: string }) {
  const channels = await listChannels(id)
  return (
    <span className="text-sm text-muted-foreground">
      {channels.length} {pluralChannels(channels.length)}
    </span>
  )
}

function LunchPill() {
  return (
    <Badge
      variant="outline"
      className="gap-1.5 border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-500"
    >
      <span className="size-1.5 rounded-full bg-amber-500" />
      На обеде
    </Badge>
  )
}

function StatusPill({ status }: { status: Manager['status'] }) {
  return (
    <Badge
      variant="outline"
      className={
        status === 'active'
          ? 'gap-1.5 border-transparent bg-success/15 text-success'
          : 'gap-1.5 border-transparent bg-muted text-muted-foreground'
      }
    >
      <span
        className={
          status === 'active'
            ? 'size-1.5 rounded-full bg-success'
            : 'size-1.5 rounded-full bg-muted-foreground'
        }
      />
      {status === 'active' ? 'Активен' : 'Заблокирован'}
    </Badge>
  )
}

export default async function ManagersPage() {
  const managers = await listManagers()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Менеджеры"
        description="Создавайте аккаунты и управляйте доступом команды."
        action={<CreateManagerDialog />}
      />

      {managers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Менеджеров пока нет"
          description="Создайте первого менеджера, чтобы он мог подключать каналы Telegram, WhatsApp и онлайн-чата."
          action={<CreateManagerDialog />}
        />
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-3 font-medium">Имя</th>
                  <th className="px-5 py-3 font-medium">Статус</th>
                  <th className="px-5 py-3 font-medium">Каналы</th>
                  <th className="px-5 py-3 font-medium">Создан</th>
                  <th className="px-5 py-3 font-medium text-right">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {managers.map((m) => (
                  <tr key={m.id} className="hover:bg-muted/30">
                    <td className="px-5 py-3">
                      <div className="font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {m.email}
                      </div>
                      {m.username ? (
                        <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                          @{m.username}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusPill status={m.status} />
                        {m.onLunch ? <LunchPill /> : null}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <ManagerRowMeta id={m.id} />
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {formatDate(m.createdAt)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <ManagerActions manager={m} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {managers.map((m) => (
              <Card key={m.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.email}
                    </p>
                    {m.username ? (
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        @{m.username}
                      </p>
                    ) : null}
                  </div>
                  <ManagerActions manager={m} />
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill status={m.status} />
                    {m.onLunch ? <LunchPill /> : null}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(m.createdAt)}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
