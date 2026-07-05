import {
  ArrowRight,
  MessageCircle,
  MessageSquare,
  Phone,
  Plug,
  Send,
  Server,
  Users,
} from 'lucide-react'
import Link from 'next/link'
import { ChannelCard } from '@/components/manager/channel-card'
import { ConnectWizard } from '@/components/manager/connect-wizard'
import { Button } from '@/components/ui/button'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { requireManager } from '@/lib/auth'
import { listChannels, listProxies } from '@/lib/data'
import { isWorkerConfigured, workerHealth } from '@/lib/worker-client'
import { type Channel, type ChannelType } from '@/lib/types'

const GROUPS: { type: ChannelType; label: string; icon: typeof Send }[] = [
  { type: 'telegram', label: 'Telegram', icon: Send },
  { type: 'whatsapp', label: 'WhatsApp', icon: Phone },
  { type: 'livechat', label: 'Онлайн-чат', icon: MessageCircle },
  { type: 'max', label: 'MAX', icon: MessageSquare },
  { type: 'vk', label: 'VK', icon: Users },
]

export default async function ConnectionsPage() {
  const session = await requireManager()
  const [channels, proxies] = await Promise.all([
    listChannels(session.sub),
    listProxies(session.sub),
  ])
  const workerOnline = isWorkerConfigured ? await workerHealth() : false

  const byType = (t: ChannelType): Channel[] =>
    channels.filter((c) => c.type === t)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Подключения"
        description="Подключайте личные аккаунты Telegram и WhatsApp, онлайн-чаты сайтов и направляйте их через прокси."
        action={<ConnectWizard proxies={proxies} />}
      />

      {!isWorkerConfigured ? (
        <Banner tone="warning">
          Воркер не настроен. Задайте WORKER_SECRET (и запустите процесс
          воркера), чтобы сессии Telegram/WhatsApp вышли в сеть.
        </Banner>
      ) : !workerOnline ? (
        <Banner tone="error">
          Воркер недоступен. Запустите процесс воркера (pm2), чтобы сессии могли
          подключаться.
        </Banner>
      ) : (
        <Banner tone="success">Воркер в сети — сессии активны.</Banner>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
            <Server className="size-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">
              {proxies.length > 0
                ? `Доступно прокси: ${proxies.length}`
                : 'Прокси не настроены'}
            </p>
            <p className="text-xs text-muted-foreground">
              Управляйте своими прокси и проверяйте назначенные на вкладке
              «Прокси».
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={
            <Link href="/app/proxies">
              Открыть прокси
              <ArrowRight className="size-4" />
            </Link>
          }
        />
      </div>

      {channels.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="Пока нет подключений"
          description="Начните с подключения первого аккаунта. Telegram — по коду из СМС, WhatsApp — сканированием QR."
          action={<ConnectWizard proxies={proxies} />}
        />
      ) : (
        <div className="flex flex-col gap-7">
          {GROUPS.map((g) => {
            const items = byType(g.type)
            const Icon = g.icon
            return (
              <section key={g.type} className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-medium">{g.label}</h2>
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {items.length}
                  </span>
                </div>
                {items.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
                    Каналы «{g.label}» не подключены.
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((c) => (
                      <ChannelCard key={c.id} channel={c} />
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Banner({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'error'
  children: React.ReactNode
}) {
  const styles =
    tone === 'success'
      ? 'border-success/30 bg-success/10 text-success'
      : tone === 'warning'
        ? 'border-warning/30 bg-warning/10 text-warning'
        : 'border-destructive/30 bg-destructive/10 text-destructive'
  return (
    <p className={`rounded-lg border px-4 py-2.5 text-sm ${styles}`}>
      {children}
    </p>
  )
}
