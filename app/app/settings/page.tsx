import { ChangePasswordForm } from '@/components/manager/change-password-form'
import { LunchToggle } from '@/components/manager/lunch-toggle'
import { NotificationSettings } from '@/components/manager/notification-settings'
import { PageHeader } from '@/components/page-parts'
import { Card } from '@/components/ui/card'
import { requireManager } from '@/lib/auth'
import { getManagerOnLunch } from '@/lib/data'

export default async function ManagerSettingsPage() {
  const session = await requireManager()
  const onLunch = await getManagerOnLunch(session.sub)

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
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-medium">Доступность</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Когда вы на обеде, новые входящие диалоги автоматически уходят другим
          свободным менеджерам. Текущие диалоги остаются у вас.
        </p>
        <div className="mt-4">
          <LunchToggle initialOnLunch={onLunch} />
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-medium">Уведомления</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Получайте push-уведомления на компьютере и телефоне о новых
          сообщениях.
        </p>
        <div className="mt-4">
          <NotificationSettings />
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-medium">Смена пароля</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Держите аккаунт в безопасности — используйте надёжный пароль.
        </p>
        <div className="mt-4">
          <ChangePasswordForm />
        </div>
      </Card>
    </div>
  )
}
