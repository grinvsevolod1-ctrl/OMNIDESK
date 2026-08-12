import { Suspense } from 'react'
import { LogOut, Mail, ShieldCheck, User, Layers } from 'lucide-react'
import { PageHeader } from '@/components/page-parts'
import { SystemHealthSection } from '@/components/admin/settings/system-health-section'
import { AuditLogSection } from '@/components/admin/settings/audit-log-section'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { requireAdmin } from '@/lib/auth'
import { logoutAction } from '@/app/actions/auth'
import pkg from '@/package.json'

// Single source of truth: package.json version, so this card can never drift
// from the actual release again (it sat at a hardcoded '0.1.0' for months).
const PANEL_VERSION = pkg.version

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export default async function AdminSettingsPage() {
  const user = await requireAdmin()
  const login = user.email.split('@')[0] || user.email

  const details = [
    { icon: User, label: 'Имя', value: user.name },
    { icon: Mail, label: 'Email', value: user.email },
    { icon: ShieldCheck, label: 'Логин', value: login, mono: true },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Настройки"
        description="Данные вашего аккаунта администратора и сведения о панели."
      />

      {/* ── Account ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Аккаунт
        </h2>
        <Card className="overflow-hidden">
          {/* Identity header */}
          <div className="flex items-center gap-4 border-b border-border bg-muted/30 p-5">
            <Avatar className="size-14">
              <AvatarFallback className="bg-secondary text-lg font-semibold text-secondary-foreground">
                {initials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{user.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                {user.email}
              </p>
            </div>
            <Badge
              variant="outline"
              className="ml-auto shrink-0 gap-1 border-primary/30 bg-primary/5 text-primary"
            >
              <ShieldCheck className="size-3" />
              Администратор
            </Badge>
          </div>

          {/* Details */}
          <div className="divide-y divide-border">
            {details.map((d) => {
              const Icon = d.icon
              return (
                <div
                  key={d.label}
                  className="flex items-center gap-3 px-5 py-3.5"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    {d.label}
                  </span>
                  <span
                    className={
                      'ml-auto truncate text-sm font-medium' +
                      (d.mono ? ' font-mono' : '')
                    }
                  >
                    {d.value}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>

        <p className="text-xs text-muted-foreground">
          Учётные данные администратора задаются при развёртывании и меняются на
          сервере. Обратитесь к администратору сервера, чтобы сменить пароль.
        </p>
      </section>

      {/* ── Session ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Сессия
        </h2>
        <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Выйти из аккаунта</p>
            <p className="text-sm text-muted-foreground">
              Завершить текущую сессию на этом устройстве.
            </p>
          </div>
          <form action={logoutAction} className="shrink-0">
            <Button type="submit" variant="outline" size="sm">
              <LogOut className="size-4" />
              Выйти
            </Button>
          </form>
        </Card>
      </section>

      {/* ── System health ── */}
      <Suspense
        fallback={
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Здоровье системы
            </h2>
            <Card className="p-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-20 animate-pulse rounded-lg border border-border bg-muted/40"
                  />
                ))}
              </div>
            </Card>
          </section>
        }
      >
        <SystemHealthSection />
      </Suspense>

      {/* ── Audit log ── */}
      <Suspense
        fallback={
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Журнал действий
            </h2>
            <Card className="h-48 animate-pulse bg-muted/20" />
          </section>
        }
      >
        <AuditLogSection />
      </Suspense>

      {/* ── About panel ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          О панели
        </h2>
        <Card className="flex items-center gap-3 p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
            <Layers className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Версия панели</p>
            <p className="text-base font-semibold tabular-nums">
              {PANEL_VERSION}
            </p>
          </div>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            omnidesk-panel
          </span>
        </Card>
      </section>
    </div>
  )
}
