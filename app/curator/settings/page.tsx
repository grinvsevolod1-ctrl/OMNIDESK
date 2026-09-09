import { getTwofaStatusAction } from '@/app/actions/twofa'
import { MyGeoSettings } from '@/components/curator/my-geo-settings'
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
import { requireCurator } from '@/lib/auth'
import { getManagerById } from '@/lib/data'

const TABS: SettingsTab[] = [
  {
    id: 'profile',
    label: 'Профиль',
    hint: 'Имя, логин, почта',
    icon: 'user',
  },
  {
    id: 'geo',
    label: 'Мои ГЕО',
    hint: 'Города и регионы',
    icon: 'map-pin',
  },
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

export default async function CuratorSettingsPage() {
  const session = await requireCurator()
  const [twofa, account] = await Promise.all([
    getTwofaStatusAction(),
    getManagerById(session.sub),
  ])

  const geoPanel = (
    <Card className="p-5">
      <h2 className="font-medium">Мои ГЕО</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Города и регионы, за которые вы отвечаете: по ним вам подбираются лиды.
        Первый город — основной.
      </p>
      <div className="mt-4">
        <MyGeoSettings />
      </div>
    </Card>
  )

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
          geo: geoPanel,
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
