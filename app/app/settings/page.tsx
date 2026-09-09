import { getTwofaStatusAction } from '@/app/actions/twofa'
import { LunchToggle } from '@/components/manager/lunch-toggle'
import { NotificationSettings } from '@/components/manager/notification-settings'
import { PageHeader } from '@/components/page-parts'
import { AppInstallCard } from '@/components/shared/app-install-card'
import {
  SettingsProfilePanel,
  SettingsSecurityPanel,
  SettingsSessionsPanel,
  SettingsTwofaPanel,
} from '@/components/shared/settings/panels'
import {
  SettingsShell,
  type SettingsTab,
} from '@/components/shared/settings-shell'
import { Card } from '@/components/ui/card'
import { requireManager } from '@/lib/auth'
import { getManagerById, getManagerOnLunch } from '@/lib/data'

const TABS: SettingsTab[] = [
  {
    id: 'profile',
    label: 'Профиль',
    hint: 'Имя, логин, почта',
    icon: 'user',
  },
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
  {
    id: 'sessions',
    label: 'Сессии',
    hint: 'Устройства и выход',
    icon: 'devices',
  },
]

export default async function ManagerSettingsPage() {
  const session = await requireManager()
  const [onLunch, twofa, account] = await Promise.all([
    getManagerOnLunch(session.sub),
    getTwofaStatusAction(),
    getManagerById(session.sub),
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Настройки" description="Управление вашим аккаунтом." />
      <SettingsShell
        tabs={TABS}
        panels={{
          profile: (
            <SettingsProfilePanel
              name={session.name}
              email={session.email}
              username={account?.username ?? null}
              avatarUrl={account?.avatarUrl ?? null}
            />
          ),
          availability: availabilityPanel,
          notifications: notificationsPanel,
          security: <SettingsSecurityPanel email={session.email} />,
          twofa: <SettingsTwofaPanel status={twofa} />,
          sessions: <SettingsSessionsPanel managerId={session.sub} />,
        }}
      >
        <AppInstallCard />
      </SettingsShell>
    </div>
  )
}
