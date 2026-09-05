import { Suspense } from 'react'
import { LogOut, Mail, ShieldCheck, User, Layers } from 'lucide-react'
import { PageHeader } from '@/components/page-parts'
import { SystemHealthSection } from '@/components/admin/settings/system-health-section'
import { AuditLogSection } from '@/components/admin/settings/audit-log-section'
import {
  SettingsIdentityCard,
  SettingsShell,
  type SettingsTab,
} from '@/components/shared/settings-shell'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AvatarUploader } from '@/components/shared/avatar-uploader'
import { requireAdmin } from '@/lib/auth'
import { logoutAction } from '@/app/actions/auth'
import {
  getAdminAvatarAction,
  updateAdminAvatarAction,
} from '@/app/actions/account'
import pkg from '@/package.json'

// Single source of truth: package.json version, so this card can never drift
// from the actual release again (it sat at a hardcoded '0.1.0' for months).
const PANEL_VERSION = pkg.version

const TABS: SettingsTab[] = [
  { id: 'account', label: 'Аккаунт', hint: 'Профиль и сессия', icon: 'user' },
  {
    id: 'health',
    label: 'Здоровье системы',
    hint: 'Мозг, очереди, кроны',
    icon: 'activity',
  },
  {
    id: 'audit',
    label: 'Журнал действий',
    hint: 'Кто и что менял',
    icon: 'file-clock',
  },
  { id: 'about', label: 'О панели', hint: 'Версия и сборка', icon: 'info' },
]

export default async function AdminSettingsPage() {
  const user = await requireAdmin()
  const login = user.email.split('@')[0] || user.email
  const adminAvatar = await getAdminAvatarAction()

  const details = [
    { icon: User, label: 'Имя', value: user.name, mono: false },
    { icon: Mail, label: 'Email', value: user.email, mono: false },
    { icon: ShieldCheck, label: 'Логин', value: login, mono: true },
  ]

  const accountPanel = (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <AvatarUploader
          name={user.name}
          initialAvatarUrl={adminAvatar}
          action={updateAdminAvatarAction}
        />
      </Card>

      <Card className="overflow-hidden">
        <div className="divide-y divide-border">
          {details.map((d) => {
            const Icon = d.icon
            return (
              <div key={d.label} className="flex items-center gap-3 px-5 py-3.5">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{d.label}</span>
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
    </div>
  )

  const healthPanel = (
    <Suspense
      fallback={
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
      }
    >
      <SystemHealthSection bare />
    </Suspense>
  )

  const auditPanel = (
    <Suspense fallback={<Card className="h-48 animate-pulse bg-muted/20" />}>
      <AuditLogSection bare />
    </Suspense>
  )

  const aboutPanel = (
    <Card className="flex items-center gap-3 p-5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
        <Layers className="size-5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Версия панели</p>
        <p className="text-base font-semibold tabular-nums">{PANEL_VERSION}</p>
      </div>
      <span className="ml-auto font-mono text-xs text-muted-foreground">
        omnidesk-panel
      </span>
    </Card>
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Настройки"
        description="Аккаунт администратора, здоровье системы и журнал действий."
      />
      <SettingsShell
        tabs={TABS}
        panels={{
          account: accountPanel,
          health: healthPanel,
          audit: auditPanel,
          about: aboutPanel,
        }}
      >
        <SettingsIdentityCard
          name={user.name}
          email={user.email}
          roleLabel="Администратор"
        />
      </SettingsShell>
    </div>
  )
}
