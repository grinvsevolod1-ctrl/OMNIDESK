import { getTwofaStatusAction } from '@/app/actions/twofa'
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
import { requireHead } from '@/lib/auth'
import { getManagerById } from '@/lib/data'

const TABS: SettingsTab[] = [
  {
    id: 'profile',
    label: 'Профиль',
    hint: 'Имя, логин, почта',
    icon: 'user',
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

export default async function HeadSettingsPage() {
  const session = await requireHead()
  const [twofa, account] = await Promise.all([
    getTwofaStatusAction(),
    getManagerById(session.sub),
  ])

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
