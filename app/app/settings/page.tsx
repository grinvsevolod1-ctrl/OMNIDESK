import { KeyRound } from 'lucide-react'
import { getTwofaStatusAction } from '@/app/actions/twofa'
import { ChangePasswordForm } from '@/components/manager/change-password-form'
import { LunchToggle } from '@/components/manager/lunch-toggle'
import { NotificationSettings } from '@/components/manager/notification-settings'
import { PageHeader } from '@/components/page-parts'
import { LoginHistory } from '@/components/shared/login-history'
import { ProfileForm } from '@/components/shared/profile-form'
import {
  SettingsIdentityCard,
  SettingsShell,
  type SettingsTab,
} from '@/components/shared/settings-shell'
import { TwofaSettings } from '@/components/shared/twofa-settings'
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

  const profilePanel = (
    <Card className="p-5">
      <h2 className="font-medium">Профиль</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Ваше имя, логин и email для входа. Изменения применяются сразу; логин
        и email должны быть уникальны.
      </p>
      <div className="mt-5">
        <ProfileForm
          initialName={session.name}
          initialUsername={account?.username ?? null}
          initialEmail={session.email}
        />
      </div>
    </Card>
  )

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
          availability: availabilityPanel,
          notifications: notificationsPanel,
          security: securityPanel,
          twofa: twofaPanel,
          sessions: sessionsPanel,
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
