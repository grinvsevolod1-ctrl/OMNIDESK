import Link from 'next/link'
import type { ComponentType } from 'react'
import { ArrowRight, MessageSquare, Server, Wifi } from 'lucide-react'
import {
  channelIcon,
  TelemostIcon,
} from '@/components/channel-icons'
import { PageHeader, StatCard } from '@/components/page-parts'
import { AccountsTable } from '@/components/admin/accounts-admin'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth'
import {
  listAdminChannels,
  listAllChannels,
  listAllProxies,
} from '@/lib/data'
import type { ChannelType } from '@/lib/types'
import { cn } from '@/lib/utils'

interface SourceMeta {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  accent: string
  /** Channel type used to count accounts. Telemost has no channel rows. */
  type?: ChannelType
}

const SOURCES: SourceMeta[] = [
  {
    label: 'Telegram',
    href: '/admin/accounts/telegram',
    icon: channelIcon('telegram'),
    accent: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    type: 'telegram',
  },
  {
    label: 'WhatsApp',
    href: '/admin/whatsapp',
    icon: channelIcon('whatsapp'),
    accent:
      'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    type: 'whatsapp',
  },
  {
    label: 'VK',
    href: '/admin/accounts/vk',
    icon: channelIcon('vk'),
    accent: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
    type: 'vk',
  },
  {
    label: 'MAX',
    href: '/admin/accounts/max',
    icon: channelIcon('max'),
    accent:
      'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    type: 'max',
  },
  {
    label: 'Онлайн-чат',
    href: '/admin/livechat',
    icon: channelIcon('livechat'),
    accent:
      'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
    type: 'livechat',
  },
  {
    label: 'Телемост',
    href: '/admin/telemost',
    icon: TelemostIcon,
    accent:
      'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  },
]

export default async function AdminAccountsPage() {
  await requireAdmin()
  const [allChannels, adminChannels, proxies] = await Promise.all([
    listAllChannels(),
    listAdminChannels(),
    listAllProxies(),
  ])
  const total = allChannels.length
  const online = allChannels.filter((c) => c.status === 'connected').length

  const byType = new Map<ChannelType, { total: number; online: number }>()
  for (const c of allChannels) {
    const entry = byType.get(c.type) ?? { total: 0, online: 0 }
    entry.total += 1
    if (c.status === 'connected') entry.online += 1
    byType.set(c.type, entry)
  }

  const proxyUsage: Record<string, string[]> = {}
  for (const c of adminChannels) {
    if (!c.proxyId) continue
    ;(proxyUsage[c.proxyId] ??= []).push(c.type)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Аккаунты"
        description="Обзор всех подключённых источников: сводка, разбивка по каналам и общий список аккаунтов с управлением прокси. Настройте каждый источник на его отдельной странице."
      />

      {/* Summary counters */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Всего аккаунтов" value={total} icon={Server} />
        <StatCard
          label="В сети"
          value={online}
          icon={Wifi}
          hint={total > 0 ? `${total - online} не в сети` : undefined}
        />
        <StatCard
          label="Источников"
          value={SOURCES.length}
          icon={MessageSquare}
        />
        <StatCard label="Прокси" value={proxies.length} icon={Server} />
      </div>

      {/* Per-source breakdown */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SOURCES.map((s) => {
          const Icon = s.icon
          const stats = s.type ? byType.get(s.type) : undefined
          return (
            <Card key={s.href} className="flex flex-col gap-4 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div
                    className={cn(
                      'flex size-10 shrink-0 items-center justify-center rounded-xl border',
                      s.accent,
                    )}
                  >
                    <Icon className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{s.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.type
                        ? `${stats?.online ?? 0} в сети · ${stats?.total ?? 0} всего`
                        : 'Видеовстречи'}
                    </p>
                  </div>
                </div>
                {s.type ? (
                  <span className="text-2xl font-semibold tracking-tight tabular-nums">
                    {stats?.total ?? 0}
                  </span>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between"
                render={<Link href={s.href} />}
              >
                Настроить
                <ArrowRight className="size-4" />
              </Button>
            </Card>
          )
        })}
      </div>

      {/* All connected accounts with proxy management */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Все аккаунты</h2>
        <AccountsTable
          channels={adminChannels}
          proxies={proxies}
          proxyUsage={proxyUsage}
        />
      </div>
    </div>
  )
}
