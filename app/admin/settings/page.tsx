import {
  Database,
  KeyRound,
  Lock,
  Server,
  ShieldCheck,
  Wifi,
} from 'lucide-react'
import { PageHeader } from '@/components/page-parts'
import { Card } from '@/components/ui/card'
import { ADMIN_EMAIL } from '@/lib/auth'
import { checkDbConnection } from '@/lib/db'
import { isWorkerConfigured, workerHealth } from '@/lib/worker-client'

export default async function AdminSettingsPage() {
  const db = await checkDbConnection()
  const workerOk = isWorkerConfigured ? await workerHealth() : false

  // Живые статусы ключевых сервисов системы.
  const services: {
    icon: typeof Server
    label: string
    ok: boolean
    okText: string
    failText: string
  }[] = [
    {
      icon: Database,
      label: 'База данных',
      ok: db.ok,
      okText: 'Подключена (PostgreSQL)',
      failText: 'Нет подключения',
    },
    {
      icon: Wifi,
      label: 'Воркер',
      ok: workerOk,
      okText: 'На связи',
      failText: isWorkerConfigured
        ? 'Не отвечает'
        : 'Не настроен (WORKER_SECRET)',
    },
  ]

  // Статус обязательных переменных окружения (без раскрытия значений).
  const config: {
    icon: typeof Server
    label: string
    ok: boolean
    value: string
  }[] = [
    {
      icon: ShieldCheck,
      label: 'Учётная запись администратора',
      ok: Boolean(ADMIN_EMAIL),
      value: ADMIN_EMAIL || 'Не задана (ADMIN_EMAIL / ADMIN_PASSWORD)',
    },
    {
      icon: KeyRound,
      label: 'Секрет сессий',
      ok: Boolean(process.env.AUTH_SECRET),
      value: process.env.AUTH_SECRET
        ? 'Настроен'
        : 'Небезопасный дефолт — задайте AUTH_SECRET',
    },
    {
      icon: Lock,
      label: 'Ключ шифрования',
      ok: Boolean(process.env.ENCRYPTION_KEY),
      value: process.env.ENCRYPTION_KEY
        ? 'Настроен'
        : 'Не задан — нужен для сессий (ENCRYPTION_KEY)',
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Система"
        description="Состояние и конфигурация этого self-hosted развёртывания."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {services.map((s) => {
          const Icon = s.icon
          return (
            <Card key={s.label} className="flex items-center gap-3 p-4">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/40">
                <Icon className="size-5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{s.label}</p>
                <p
                  className={
                    s.ok
                      ? 'text-xs text-success'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {s.ok ? s.okText : s.failText}
                </p>
              </div>
              <span
                className={
                  s.ok
                    ? 'size-2.5 shrink-0 rounded-full bg-success'
                    : 'size-2.5 shrink-0 rounded-full bg-muted-foreground/40'
                }
                aria-hidden
              />
            </Card>
          )
        })}
      </div>

      <Card className="divide-y divide-border">
        {config.map((r) => {
          const Icon = r.icon
          return (
            <div
              key={r.label}
              className="flex items-center justify-between gap-3 px-5 py-4"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/40">
                  <Icon className="size-4 text-muted-foreground" />
                </div>
                <span className="text-sm font-medium">{r.label}</span>
              </div>
              <span
                className={
                  r.ok
                    ? 'text-right text-sm text-muted-foreground'
                    : 'text-right text-sm text-warning'
                }
              >
                {r.value}
              </span>
            </div>
          )
        })}
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2">
          <Server className="size-4 text-muted-foreground" />
          <h2 className="font-medium">Развёртывание</h2>
        </div>
        <div className="mt-3 space-y-3 text-sm text-muted-foreground">
          <p>
            Приложение работает целиком на вашем VPS с PostgreSQL — без внешних
            сервисов. Настройте следующие переменные окружения:
          </p>
          <ul className="space-y-2">
            {[
              ['DATABASE_URL', 'Строка подключения к PostgreSQL'],
              ['ADMIN_EMAIL', 'Email для входа администратора'],
              ['ADMIN_PASSWORD', 'Пароль администратора'],
              ['AUTH_SECRET', 'Случайный секрет для подписи сессий'],
              ['ENCRYPTION_KEY', 'Шифрует сессии и секреты (совпадает с воркером)'],
              ['WORKER_SECRET', 'Общий секрет для API панель ↔ воркер'],
              ['WORKER_URL', 'Адрес воркера (по умолчанию http://127.0.0.1:4000)'],
            ].map(([key, desc]) => (
              <li
                key={key}
                className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <code className="font-mono text-xs text-foreground">{key}</code>
                <span className="text-xs">{desc}</span>
              </li>
            ))}
          </ul>
          <div
            className={
              db.ok
                ? 'rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-xs text-success'
                : 'rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning'
            }
          >
            {db.message}
          </div>
        </div>
      </Card>
    </div>
  )
}
