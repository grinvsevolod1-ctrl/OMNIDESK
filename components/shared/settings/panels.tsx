import { KeyRound } from 'lucide-react'
import { ChangePasswordForm } from '@/components/manager/change-password-form'
import { AvatarUploader } from '@/components/shared/avatar-uploader'
import { LoginHistory } from '@/components/shared/login-history'
import { ProfileForm } from '@/components/shared/profile-form'
import { TwofaSettings } from '@/components/shared/twofa-settings'
import type { TwofaStatus } from '@/app/actions/twofa'
import { Card } from '@/components/ui/card'

/**
 * Settings panels shared verbatim by every role's settings page (manager,
 * curator, head — profile / security / 2FA / sessions were byte-for-byte
 * identical). Role-specific panels (manager lunch, curator geo, notification
 * copy) stay in each page; these are the ones that never differed.
 */

/** Profile card: avatar uploader + name/login/email form. */
export function SettingsProfilePanel({
  name,
  email,
  username,
  avatarUrl,
}: {
  name: string
  email: string
  username: string | null
  avatarUrl: string | null
}) {
  return (
    <Card className="p-5">
      <h2 className="font-medium">Профиль</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Ваше имя, логин и email для входа. Изменения применяются сразу; логин и
        email должны быть уникальны.
      </p>
      <div className="mt-5 border-b border-border pb-5">
        <AvatarUploader name={name} initialAvatarUrl={avatarUrl} />
      </div>
      <div className="mt-5">
        <ProfileForm
          initialName={name}
          initialUsername={username}
          initialEmail={email}
        />
      </div>
    </Card>
  )
}

/** Security card: change-password form with the key icon header. */
export function SettingsSecurityPanel({ email }: { email: string }) {
  return (
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
        <ChangePasswordForm email={email} />
      </div>
    </Card>
  )
}

/** Two-factor panel; renders nothing until the 2FA status has loaded. */
export function SettingsTwofaPanel({ status }: { status: TwofaStatus | null }) {
  return status ? <TwofaSettings initial={status} /> : null
}

/** Active-sessions / login history panel. */
export function SettingsSessionsPanel({ managerId }: { managerId: string }) {
  return <LoginHistory managerId={managerId} />
}
