import type { ComponentType } from 'react'
import { channelIcon } from '@/components/channel-icons'
import { PageHeader } from '@/components/page-parts'
import { AccountsAdmin } from '@/components/admin/accounts-admin'
import { Card } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth'
import { listAdminChannels, listAllProxies, listManagers } from '@/lib/data'
import { isWorkerConfigured, workerHealthCached } from '@/lib/worker-client'

type Source = 'telegram' | 'vk' | 'max'

interface SourceMeta {
  title: string
  description: string
  icon: ComponentType<{ className?: string }>
  /** Telegram needs the worker online; token-based sources don't. */
  needsWorker: boolean
  steps: string[]
}

const META: Record<Source, SourceMeta> = {
  telegram: {
    title: 'Telegram',
    description:
      'Подключение личных аккаунтов Telegram по номеру телефона через MTProto. Для входа нужен запущенный процесс воркера на VPS.',
    icon: channelIcon('telegram'),
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
    icon: channelIcon('vk'),
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
    icon: channelIcon('max'),
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
  const [channels, proxies, managers, workerOnline] = await Promise.all([
    listAdminChannels(),
    listAllProxies(),
    listManagers(),
    isWorkerConfigured ? workerHealthCached() : Promise.resolve(false),
  ])

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
          {/* Бренд-иконка без подложки: логотипы самодостаточны */}
          <Icon className="size-9 shrink-0" />
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
