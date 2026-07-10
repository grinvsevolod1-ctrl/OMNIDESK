import type { LucideIcon } from 'lucide-react'
import { MessageSquare, Send, Users } from 'lucide-react'
import { PageHeader } from '@/components/page-parts'
import { AccountsAdmin } from '@/components/admin/accounts-admin'
import { Card } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth'
import { listAdminChannels, listAllProxies, listManagers } from '@/lib/data'
import { isWorkerConfigured, workerHealth } from '@/lib/worker-client'
import { cn } from '@/lib/utils'

type Source = 'telegram' | 'vk' | 'max'

interface SourceMeta {
  title: string
  description: string
  icon: LucideIcon
  /** Tailwind classes for the brand accent (icon tile). */
  accent: string
  /** Telegram needs the worker online; token-based sources don't. */
  needsWorker: boolean
  steps: string[]
}

const META: Record<Source, SourceMeta> = {
  telegram: {
    title: 'Telegram',
    description:
      'Подключение личных аккаунтов Telegram по номеру телефона через MTProto. Для входа нужен запущенный процесс воркера на VPS.',
    icon: Send,
    accent: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    needsWorker: true,
    steps: [
      'Выберите менеджера-владельца и, при необходимости, прокси (MTProto или без прокси).',
      'Введите номер телефона аккаунта и нажмите «Подключить».',
      'Введите код из приложения Telegram, а если включена двухэтапная аутентификация — облачный пароль.',
    ],
  },
  vk: {
    title: 'VK',
    description:
      'Подключение сообществ VK через ключ доступа с правами на сообщения. Воркер не требуется — сообщения идут по Long Poll API.',
    icon: Users,
    accent: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
    needsWorker: false,
    steps: [
      'В управлении сообществом VK → «Работа с API» создайте ключ доступа со scope messages и manage.',
      'Включите Long Poll API (последняя версия) и события входящих сообщений.',
      'Назначьте менеджера, вставьте токен и нажмите «Подключить».',
    ],
  },
  max: {
    title: 'MAX',
    description:
      'Подключение ботов мессенджера MAX по токену из @MasterBot. Воркер не требуется.',
    icon: MessageSquare,
    accent: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    needsWorker: false,
    steps: [
      'Создайте бота в @MasterBot и скопируйте выданный токен.',
      'Назначьте менеджера-владельца и, при необходимости, прокси.',
      'Вставьте токен бота и нажмите «Подключить».',
    ],
  },
}

export async function SourceAccountsPage({ source }: { source: Source }) {
  await requireAdmin()
  const [channels, proxies, managers] = await Promise.all([
    listAdminChannels(),
    listAllProxies(),
    listManagers(),
  ])
  const workerOnline = isWorkerConfigured ? await workerHealth() : false

  // Proxy usage map (same shape the create form expects): proxyId -> types[].
  const proxyUsage: Record<string, string[]> = {}
  for (const c of channels) {
    if (!c.proxyId) continue
    ;(proxyUsage[c.proxyId] ??= []).push(c.type)
  }

  const meta = META[source]
  const Icon = meta.icon
  const sourceChannels = channels.filter((c) => c.type === source)
  const legacyNoProxy = sourceChannels.filter((c) => !c.proxyId).length

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={meta.title} description={meta.description} />

      {/* Worker status (only sources that depend on it) */}
      {meta.needsWorker && !isWorkerConfigured ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          Воркер не настроен — задайте WORKER_SECRET и WORKER_URL, затем
          запустите процесс воркера на VPS. Без него недоступен вход в Telegram.
        </p>
      ) : meta.needsWorker && !workerOnline ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          Воркер не в сети — Telegram-вход требует запущенного процесса воркера
          на VPS (проверьте pm2).
        </p>
      ) : null}

      {legacyNoProxy > 0 ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          {legacyNoProxy === 1 ? 'Один аккаунт' : `${legacyNoProxy} аккаунтов`}{' '}
          подключены без прокси. Назначьте им прокси, чтобы трафик шёл через
          выделенный IP.
        </p>
      ) : null}

      {/* Setup guide */}
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl border',
              meta.accent,
            )}
          >
            <Icon className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Как подключить {meta.title}</h2>
            <ol className="mt-2 flex flex-col gap-2">
              {meta.steps.map((step, i) => (
                <li key={i} className="flex gap-2.5 text-sm text-muted-foreground">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted/50 text-[11px] font-medium text-foreground">
                    {i + 1}
                  </span>
                  <span className="leading-relaxed text-pretty">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </Card>

      <AccountsAdmin
        channels={channels}
        proxies={proxies}
        managers={managers}
        proxyUsage={proxyUsage}
        workerOnline={workerOnline}
        only={source}
      />
    </div>
  )
}
