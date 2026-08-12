import { ChangePasswordForm } from '@/components/manager/change-password-form'
import { NotificationSettings } from '@/components/manager/notification-settings'
import { PageHeader } from '@/components/page-parts'
import { Card } from '@/components/ui/card'
import { requireCurator } from '@/lib/auth'

export default async function CuratorSettingsPage() {
  const session = await requireCurator()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Настройки" description="Управление вашим аккаунтом." />

      <Card className="p-5">
        <h2 className="font-medium">Профиль</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Имя</span>
            <span className="text-sm">{session.name}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Email</span>
            <span className="text-sm">{session.email}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Роль</span>
            <span className="text-sm">Менеджер по кадрам</span>
          </div>
        </div>
      </Card>

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

      <Card className="p-5">
        <h2 className="font-medium">Уведомления</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Push-уведомления о новых лидах и напоминания по статусам приходят
          на это устройство даже при закрытой вкладке.
        </p>
        <div className="mt-4">
          <NotificationSettings />
        </div>
      </Card>
    </div>
  )
}
