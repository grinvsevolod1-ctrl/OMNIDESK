import { ChangePasswordForm } from '@/components/manager/change-password-form'
import { NotificationSettings } from '@/components/manager/notification-settings'
import { PageHeader } from '@/components/page-parts'
import {
  SettingsIdentityCard,
  SettingsShell,
  type SettingsTab,
} from '@/components/shared/settings-shell'
import { Card } from '@/components/ui/card'
import { requireCurator } from '@/lib/auth'

const TABS: SettingsTab[] = [
  {
    id: 'notifications',
    label: 'Уведомления',
    hint: 'Лиды и напоминания',
    icon: 'bell',
  },
  {
    id: 'security',
    label: 'Безопасность',
    hint: 'Смена пароля',
    icon: 'key',
  },
]

export default async function CuratorSettingsPage() {
  const session = await requireCurator()

  const notificationsPanel = (
    <Card className="p-5">
      <h2 className="font-medium">Push-уведомления</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Push-уведомления о новых лидах и напоминания по статусам приходят на
        это устройство даже при закрытой вкладке.
      </p>
      <div className="mt-4">
        <NotificationSettings />
      </div>
    </Card>
  )

  const securityPanel = (
    <Card className="p-5">
      <h2 className="font-medium">Смена пароля</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        После смены пароля все остальные устройства будут разлогинены —
        текущая сессия останется активной.
      </p>
      <div className="mt-4">
        <ChangePasswordForm />
      </div>
    </Card>
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Настройки" description="Управление вашим аккаунтом." />
      <SettingsShell
        tabs={TABS}
        panels={{
          notifications: notificationsPanel,
          security: securityPanel,
        }}
      >
        <SettingsIdentityCard
          name={session.name}
          email={session.email}
          roleLabel="Менеджер по кадрам"
        />
      </SettingsShell>
    </div>
  )
}
