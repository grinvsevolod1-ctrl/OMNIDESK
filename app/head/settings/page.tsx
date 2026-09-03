import { KeyRound } from 'lucide-react'
import { getTwofaStatusAction } from '@/app/actions/twofa'
import { ChangePasswordForm } from '@/components/manager/change-password-form'
import { PageHeader } from '@/components/page-parts'
import { AvatarUploader } from '@/components/shared/avatar-uploader'
import { LoginHistory } from '@/components/shared/login-history'
import { ProfileForm } from '@/components/shared/profile-form'
import {
  SettingsIdentityCard,
  SettingsShell,
  type SettingsTab,
} from '@/components/shared/settings-shell'
import { TwofaSettings } from '@/components/shared/twofa-settings'
import { Card } from '@/components/ui/card'
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

  const profilePanel = (
    <Card className="p-5">
      <h2 className="font-medium">Профиль</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Ваше имя, логин и email для входа. Изменения применяются сразу; логин
        и email должны быть уникальны.
      </p>
      <div className="mt-5 border-b border-border pb-5">
        <AvatarUploader
          name={session.name}
          initialAvatarUrl={account?.avatarUrl ?? null}
        />
      </div>
      <div className="mt-5">
        <ProfileForm
          initialName={session.name}
          initialUsername={account?.username ?? null}
          initialEmail={session.email}
        />
      </div>
    </Card>
  )

  const securityPanel = (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <KeyRound className="size-5 text-muted-foreground" />
        </div>
        <div>
          <h2 className="font-medium">Смена пароля</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Держите аккаунт в безопасности — используйте надёжный пароль.
          </p>
        </div>
      </div>
      <div className="mt-5">
        <ChangePasswordForm email={session.email} />
      </div>
    </Card>
  )

  const twofaPanel = twofa ? <TwofaSettings initial={twofa} /> : null

  const sessionsPanel = <LoginHistory managerId={session.sub} />

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Настройки" description="Управление вашим аккаунтом." />
      <SettingsShell
        tabs={TABS}
        panels={{
          profile: profilePanel,
          security: securityPanel,
          twofa: twofaPanel,
          sessions: sessionsPanel,
        }}
      >
        <SettingsIdentityCard
          name={session.name}
          email={session.email}
          roleLabel="Руководитель"
        />
      </SettingsShell>
    </div>
  )
}
