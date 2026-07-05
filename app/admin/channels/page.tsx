import {
  MessageCircle,
  MessageSquare,
  Phone,
  Radio,
  Send,
  Users,
} from 'lucide-react'
import { EmptyState, PageHeader, StatusBadge } from '@/components/page-parts'
import { Card } from '@/components/ui/card'
import { listAllChannels, listManagers } from '@/lib/data'
import { CHANNEL_META, type ChannelType } from '@/lib/types'

const ICONS: Record<ChannelType, typeof Send> = {
  telegram: Send,
  whatsapp: Phone,
  livechat: MessageCircle,
  max: MessageSquare,
  vk: Users,
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'никогда'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'только что'
  if (mins < 60) return `${mins} мин назад`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} ч назад`
  return `${Math.floor(hours / 24)} дн назад`
}

export default async function AdminChannelsPage() {
  const [channels, managers] = await Promise.all([
    listAllChannels(),
    listManagers(),
  ])
  const managerName = new Map(managers.map((m) => [m.id, m.name]))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Все каналы"
        description="Обзор всех каналов, подключённых вашей командой (только просмотр)."
      />

      {channels.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="Каналы не подключены"
          description="Как только менеджеры подключат каналы Telegram, WhatsApp или онлайн-чата, они появятся здесь."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((c) => {
            const Icon = ICONS[c.type]
            return (
              <Card key={c.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/40">
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {CHANNEL_META[c.type].label}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={c.status} />
                </div>
                <div className="mt-4 space-y-1.5 text-xs text-muted-foreground">
                  <div className="flex justify-between gap-2">
                    <span>Детали</span>
                    <span className="truncate font-mono text-foreground">
                      {c.detail}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>Менеджер</span>
                    <span className="truncate text-foreground">
                      {(c.managerId && managerName.get(c.managerId)) ||
                        'Не назначен'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>Проверка</span>
                    <span className="text-foreground">
                      {timeAgo(c.lastCheckedAt)}
                    </span>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
