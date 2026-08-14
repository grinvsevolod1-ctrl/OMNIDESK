import { getTwofaStatusAction } from '@/app/actions/twofa'
import { ChangePasswordForm } from '@/components/manager/change-password-form'
import { LunchToggle } from '@/components/manager/lunch-toggle'
import { NotificationSettings } from '@/components/manager/notification-settings'
import { PageHeader } from '@/components/page-parts'
import {
  SettingsIdentityCard,
  SettingsShell,
  type SettingsTab,
} from '@/components/shared/settings-shell'
import { TwofaSettings } from '@/components/shared/twofa-settings'
import { Card } from '@/components/ui/card'
import { requireManager } from '@/lib/auth'
import { getManagerOnLunch } from '@/lib/data'

const TABS: SettingsTab[] = [
  {
    id: 'availability',
    label: 'Доступность',
    hint: 'Обед и распределение',
    icon: 'lunch',
  },
  {
    id: 'notifications',
    label: 'Уведомления',
    hint: 'Push на устройства',
    icon: 'bell',
  },
  {
    id: 'security',
    label: 'Безопасность',
    hint: 'Смена пароля',
    icon: 'key',
  },
  {
    id: 'twofa',
    label: 'Двухфакторная защита',
    hint: 'Второй фактор входа',
    icon: 'shield',
  },
]

export default async function ManagerSettingsPage() {
  const session = await requireManager()
  const [onLunch, twofa] = await Promise.all([
    getManagerOnLunch(session.sub),
    getTwofaStatusAction(),
  ])

  const availabilityPanel = (
    <Card className="p-5">
      <h2 className="font-medium">Режим обеда</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Когда вы на обеде, новые входящие диалоги автоматически уходят другим
        свободным менеджерам. Текущие диалоги остаются у вас.
      </p>
      <div className="mt-4">
        <LunchToggle initialOnLunch={onLunch} />
      </div>
    </Card>
  )

  const notificationsPanel = (
    <Card className="p-5">
      <h2 className="font-medium">Push-уведомления</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Получайте push-уведомления на компьютере и телефоне о новых сообщениях.
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
        Держите аккаунт в безопасности — используйте надёжный пароль. После
        смены все остальные устройства будут разлогинены.
      </p>
      <div className="mt-4">
        <ChangePasswordForm />
      </div>
    </Card>
  )

  const twofaPanel = twofa ? <TwofaSettings initial={twofa} /> : null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Настройки" description="Управление вашим аккаунтом." />
      <SettingsShell
        tabs={TABS}
        panels={{
          availability: availabilityPanel,
          notifications: notificationsPanel,
          security: securityPanel,
          twofa: twofaPanel,
        }}
      >
        <SettingsIdentityCard
          name={session.name}
          email={session.email}
          roleLabel="Менеджер"
        />
      </SettingsShell>
    </div>
  )
}
