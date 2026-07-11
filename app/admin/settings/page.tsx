import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Database,
  Lock,
  Server,
  ShieldCheck,
  Wifi,
  XCircle,
  FileCode2,
  Globe,
  RefreshCw,
  Terminal,
  Layers,
} from 'lucide-react'
import { PageHeader } from '@/components/page-parts'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ADMIN_EMAIL } from '@/lib/auth'
import { checkDbConnection } from '@/lib/db'
import { isWorkerConfigured, workerHealth } from '@/lib/worker-client'
import { isEncryptionConfigured } from '@/lib/crypto'
import { listAllChannels, listManagers } from '@/lib/data'
import { cn } from '@/lib/utils'

function env(key: string): 'ok' | 'missing' {
  return process.env[key] ? 'ok' : 'missing'
}

export default async function AdminSettingsPage() {
  const [db, channels, managers] = await Promise.all([
    checkDbConnection(),
    listAllChannels().catch(() => []),
    listManagers().catch(() => []),
  ])
  const workerOk = isWorkerConfigured ? await workerHealth() : false

  const channelsOnline = channels.filter((c) => c.status === 'connected').length
  const managersActive = managers.filter((m) => m.status === 'active').length

  /* ── Live service status ─────────────────────────────────────── */
  const services = [
    {
      icon: Database,
      label: 'База данных',
      sublabel: 'PostgreSQL',
      state: db.ok ? ('ok' as const) : ('error' as const),
      detail: db.ok ? db.message : db.message,
    },
    {
      icon: Wifi,
      label: 'Воркер',
      sublabel: process.env.WORKER_URL || 'http://127.0.0.1:4000',
      state: !isWorkerConfigured
        ? ('warn' as const)
        : workerOk
          ? ('ok' as const)
          : ('error' as const),
      detail: !isWorkerConfigured
        ? 'WORKER_SECRET не задан'
        : workerOk
          ? 'На связи'
          : 'Не отвечает',
    },
    {
      icon: Lock,
      label: 'Шифрование',
      sublabel: 'AES-256-GCM',
      state: isEncryptionConfigured() ? ('ok' as const) : ('warn' as const),
      detail: isEncryptionConfigured()
        ? 'ENCRYPTION_KEY настроен'
        : 'ENCRYPTION_KEY не задан — токены и секреты не зашифрованы',
    },
    {
      icon: ShieldCheck,
      label: 'Аутентификация',
      sublabel: 'Cookie-сессии',
      state:
        Boolean(process.env.AUTH_SECRET) && Boolean(ADMIN_EMAIL)
          ? ('ok' as const)
          : ('warn' as const),
      detail:
        Boolean(process.env.AUTH_SECRET) && Boolean(ADMIN_EMAIL)
          ? `Аккаунт: ${ADMIN_EMAIL}`
          : !ADMIN_EMAIL
            ? 'ADMIN_EMAIL не задан — вход администратора недоступен'
            : 'AUTH_SECRET не задан — используется небезопасный дефолт',
    },
  ]

  /* ── Security checklist ──────────────────────────────────────── */
  type Severity = 'critical' | 'warn' | 'ok'
  const checks: { label: string; ok: boolean; severity: Severity; hint: string }[] = [
    {
      label: 'ADMIN_EMAIL задан',
      ok: Boolean(ADMIN_EMAIL),
      severity: 'critical',
      hint: 'Без него вход в панель невозможен.',
    },
    {
      label: 'ADMIN_PASSWORD задан',
      ok: Boolean(process.env.ADMIN_PASSWORD),
      severity: 'critical',
      hint: 'Обязателен для входа администратора.',
    },
    {
      label: 'AUTH_SECRET задан',
      ok: Boolean(process.env.AUTH_SECRET),
      severity: 'critical',
      hint: 'Подписывает сессионные JWT. Без него используется небезопасный дефолт.',
    },
    {
      label: 'ENCRYPTION_KEY задан',
      ok: isEncryptionConfigured(),
      severity: 'critical',
      hint: 'Шифрует Telegram/WhatsApp-сессии, прокси и OAuth-токены.',
    },
    {
      label: 'WORKER_SECRET задан',
      ok: isWorkerConfigured,
      severity: 'warn',
      hint: 'Нужен для работы WhatsApp-каналов и прокси.',
    },
    {
      label: 'DATABASE_URL задан',
      ok: Boolean(process.env.DATABASE_URL),
      severity: 'critical',
      hint: 'Подключение к PostgreSQL.',
    },
    {
      label: 'SECRET_PANEL_PASSWORD задан',
      ok: Boolean(process.env.SECRET_PANEL_PASSWORD),
      severity: 'warn',
      hint: 'Дополнительная защита god-консоли вторым паролем.',
    },
    {
      label: 'CRON_SECRET задан',
      ok: Boolean(process.env.CRON_SECRET),
      severity: 'warn',
      hint: 'Защищает cron-роуты автосинка рекламы.',
    },
  ]

  const criticalFails = checks.filter((c) => !c.ok && c.severity === 'critical').length
  const warnFails = checks.filter((c) => !c.ok && c.severity === 'warn').length

  /* ── Env reference ───────────────────────────────────────────── */
  const envGroups: {
    label: string
    icon: typeof Server
    vars: { key: string; desc: string; required: boolean }[]
  }[] = [
    {
      label: 'База данных',
      icon: Database,
      vars: [
        { key: 'DATABASE_URL', desc: 'Строка подключения к PostgreSQL', required: true },
        { key: 'DATABASE_SSL', desc: 'Включить TLS (true/false)', required: false },
        { key: 'DATABASE_CA_CERT', desc: 'PEM-сертификат CA для TLS', required: false },
      ],
    },
    {
      label: 'Безопасность',
      icon: ShieldCheck,
      vars: [
        { key: 'ADMIN_EMAIL', desc: 'Email администратора', required: true },
        { key: 'ADMIN_PASSWORD', desc: 'Пароль администратора', required: true },
        { key: 'AUTH_SECRET', desc: 'Секрет подписи JWT-сессий', required: true },
        { key: 'ENCRYPTION_KEY', desc: 'Ключ шифрования AES-256 (hex 64 символа)', required: true },
        { key: 'SECRET_PANEL_PASSWORD', desc: 'Второй пароль для /wijegniwjgwjog', required: false },
      ],
    },
    {
      label: 'Воркер',
      icon: Wifi,
      vars: [
        { key: 'WORKER_SECRET', desc: 'Общий секрет панель ↔ воркер', required: true },
        { key: 'WORKER_URL', desc: 'Адрес воркера (по умолчанию http://127.0.0.1:4000)', required: false },
      ],
    },
    {
      label: 'Интеграции',
      icon: Globe,
      vars: [
        { key: 'CRON_SECRET', desc: 'Защита cron-роута автосинка рекламы', required: false },
      ],
    },
  ]

  /* ── Deploy info ─────────────────────────────────────────────── */
  const sqlCount = 45 // примерное число миграций; точное значение — ls scripts/*.sql | wc -l

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Система"
        description="Статус сервисов, конфигурация и чек-лист безопасности развёртывания."
      />

      {/* ── Summary strip ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          {
            label: 'Сервисов',
            value: `${services.filter((s) => s.state === 'ok').length} / ${services.length}`,
            ok: services.every((s) => s.state === 'ok'),
          },
          {
            label: 'Каналов онлайн',
            value: `${channelsOnline} / ${channels.length}`,
            ok: channels.length > 0 && channelsOnline === channels.length,
          },
          {
            label: 'Менеджеров активных',
            value: `${managersActive} / ${managers.length}`,
            ok: managers.length > 0 && managersActive > 0,
          },
          {
            label: 'Критических проблем',
            value: criticalFails > 0 ? String(criticalFails) : 'Нет',
            ok: criticalFails === 0,
          },
        ].map((s) => (
          <Card
            key={s.label}
            className={cn(
              'flex flex-col gap-1 p-4',
              !s.ok && 'border-warning/40 bg-warning/5',
            )}
          >
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p
              className={cn(
                'text-2xl font-semibold tabular-nums',
                s.ok ? 'text-foreground' : 'text-warning',
              )}
            >
              {s.value}
            </p>
          </Card>
        ))}
      </div>

      {/* ── Services ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Сервисы
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {services.map((s) => {
            const Icon = s.icon
            const StateIcon =
              s.state === 'ok'
                ? CheckCircle2
                : s.state === 'warn'
                  ? AlertTriangle
                  : XCircle
            return (
              <Card
                key={s.label}
                className={cn(
                  'flex items-start gap-3 p-4',
                  s.state === 'error' && 'border-destructive/30 bg-destructive/5',
                  s.state === 'warn' && 'border-warning/30 bg-warning/5',
                )}
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                  <Icon className="size-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{s.label}</p>
                    <span className="text-xs text-muted-foreground">{s.sublabel}</span>
                  </div>
                  <p
                    className={cn(
                      'mt-0.5 text-xs',
                      s.state === 'ok' && 'text-success',
                      s.state === 'warn' && 'text-warning',
                      s.state === 'error' && 'text-destructive',
                    )}
                  >
                    {s.detail}
                  </p>
                </div>
                <StateIcon
                  className={cn(
                    'size-4 shrink-0',
                    s.state === 'ok' && 'text-success',
                    s.state === 'warn' && 'text-warning',
                    s.state === 'error' && 'text-destructive',
                  )}
                />
              </Card>
            )
          })}
        </div>
      </section>

      {/* ── Security checklist ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Чек-лист безопасности
          </h2>
          <div className="flex items-center gap-2">
            {criticalFails > 0 && (
              <Badge variant="destructive" className="gap-1 text-xs">
                <XCircle className="size-3" />
                {criticalFails} критических
              </Badge>
            )}
            {warnFails > 0 && (
              <Badge variant="outline" className="gap-1 border-warning/40 bg-warning/10 text-warning text-xs">
                <AlertTriangle className="size-3" />
                {warnFails} предупреждений
              </Badge>
            )}
            {criticalFails === 0 && warnFails === 0 && (
              <Badge variant="outline" className="gap-1 border-success/40 bg-success/10 text-success text-xs">
                <CheckCircle2 className="size-3" />
                Всё настроено
              </Badge>
            )}
          </div>
        </div>
        <Card className="divide-y divide-border overflow-hidden">
          {checks.map((c) => (
            <div
              key={c.label}
              className={cn(
                'flex items-center gap-3 px-4 py-3',
                !c.ok && c.severity === 'critical' && 'bg-destructive/5',
                !c.ok && c.severity === 'warn' && 'bg-warning/5',
              )}
            >
              {c.ok ? (
                <CheckCircle2 className="size-4 shrink-0 text-success" />
              ) : c.severity === 'critical' ? (
                <XCircle className="size-4 shrink-0 text-destructive" />
              ) : (
                <AlertTriangle className="size-4 shrink-0 text-warning" />
              )}
              <span className="flex-1 text-sm font-medium font-mono">{c.label}</span>
              {!c.ok ? (
                <span className="text-right text-xs text-muted-foreground max-w-xs">
                  {c.hint}
                </span>
              ) : (
                <Circle className="size-2 shrink-0 fill-success text-success" />
              )}
            </div>
          ))}
        </Card>
      </section>

      {/* ── Env vars reference ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Переменные окружения
        </h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {envGroups.map((group) => {
            const GroupIcon = group.icon
            return (
              <Card key={group.label} className="overflow-hidden">
                <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
                  <GroupIcon className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{group.label}</span>
                </div>
                <div className="divide-y divide-border">
                  {group.vars.map((v) => (
                    <div
                      key={v.key}
                      className="flex items-start justify-between gap-3 px-4 py-2.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            'size-1.5 shrink-0 rounded-full mt-1.5',
                            env(v.key) === 'ok'
                              ? 'bg-success'
                              : v.required
                                ? 'bg-destructive'
                                : 'bg-muted-foreground/40',
                          )}
                        />
                        <code className="text-xs font-mono text-foreground">
                          {v.key}
                        </code>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-right text-xs text-muted-foreground max-w-[200px]">
                          {v.desc}
                        </span>
                        {v.required && env(v.key) === 'missing' && (
                          <Badge
                            variant="outline"
                            className="border-destructive/40 bg-destructive/5 text-destructive text-[10px] px-1.5 py-0"
                          >
                            Обязателен
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )
          })}
        </div>
      </section>

      {/* ── Deploy info ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Развёртывание
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              icon: Layers,
              label: 'Версия панели',
              value: '0.1.0',
              sub: 'omnidesk-panel',
            },
            {
              icon: FileCode2,
              label: 'Миграций схемы',
              value: String(sqlCount),
              sub: 'scripts/*.sql',
            },
            {
              icon: Terminal,
              label: 'Режим',
              value: process.env.NODE_ENV === 'production' ? 'Production' : 'Development',
              sub: process.env.NODE_ENV ?? 'unknown',
            },
          ].map((item) => {
            const Icon = item.icon
            return (
              <Card key={item.label} className="flex items-center gap-3 p-4">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                  <Icon className="size-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className="text-base font-semibold">{item.value}</p>
                  <p className="text-xs text-muted-foreground font-mono">{item.sub}</p>
                </div>
              </Card>
            )
          })}
        </div>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <RefreshCw className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Как применить миграции</span>
          </div>
          <div className="rounded-lg bg-muted/50 border border-border px-3 py-2.5 font-mono text-xs text-muted-foreground space-y-1">
            <p className="text-foreground">
              # Применить все миграции по порядку:
            </p>
            <p>
              {'psql $DATABASE_URL -f scripts/001_schema.sql'}
            </p>
            <p>{'psql $DATABASE_URL -f scripts/045_ads_integration.sql'}</p>
            <p className="text-foreground mt-2"># Или через bash loop:</p>
            <p>
              {
                "for f in scripts/*.sql; do psql $DATABASE_URL -f \"$f\"; done"
              }
            </p>
          </div>
          <div
            className={cn(
              'mt-3 rounded-lg border px-3 py-2 text-xs',
              db.ok
                ? 'border-success/30 bg-success/5 text-success'
                : 'border-warning/30 bg-warning/5 text-warning',
            )}
          >
            <span className="font-medium">БД:</span> {db.message}
          </div>
        </Card>
      </section>
    </div>
  )
}
