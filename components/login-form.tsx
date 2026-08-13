'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  AlertCircle,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  Smartphone,
  User,
} from 'lucide-react'
import {
  cancel2faAction,
  loginAction,
  verify2faAction,
  type LoginState,
  type Verify2faState,
} from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function SubmitButton({ label = 'Войти' }: { label?: string }) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      disabled={pending}
      className="press-scale mt-1 h-12 w-full rounded-xl text-base font-medium"
    >
      {pending ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          Вход…
        </>
      ) : (
        label
      )}
    </Button>
  )
}

/**
 * Шаг 2FA: пароль верен, ждём 6-значный код (приложение или Telegram-бот)
 * либо одноразовый резервный код.
 */
function TwofaStep({ method }: { method: 'totp' | 'telegram' }) {
  const [state, formAction] = useActionState<Verify2faState, FormData>(
    verify2faAction,
    {},
  )
  const [useBackup, setUseBackup] = useState(false)

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
          {method === 'telegram' ? (
            <Smartphone className="size-5 text-primary" />
          ) : (
            <ShieldCheck className="size-5 text-primary" />
          )}
        </div>
        <div className="space-y-1">
          <p className="text-base font-medium">Подтвердите вход</p>
          <p className="text-sm text-muted-foreground text-pretty">
            {useBackup
              ? 'Введите один из резервных кодов (формат 0000-0000). Каждый работает один раз.'
              : method === 'telegram'
                ? 'Мы отправили 6-значный код вашему Telegram-боту. Код действует 5 минут.'
                : 'Откройте приложение-аутентификатор и введите 6-значный код.'}
          </p>
        </div>
      </div>

      <div className="relative">
        <KeyRound className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          name="code"
          type="text"
          inputMode={useBackup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          placeholder={useBackup ? '0000-0000' : '000000'}
          maxLength={useBackup ? 9 : 6}
          required
          autoFocus
          className="h-12 rounded-xl pl-11 text-center font-mono text-lg tracking-[0.3em]"
        />
      </div>
      {useBackup ? <input type="hidden" name="backup" value="1" /> : null}

      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3 text-sm text-destructive duration-300 animate-in fade-in slide-in-from-top-1"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      ) : null}

      <SubmitButton label="Подтвердить" />

      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          onClick={() => setUseBackup((v) => !v)}
        >
          {useBackup ? 'Ввести обычный код' : 'Использовать резервный код'}
        </button>
        <button
          type="button"
          className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          onClick={() => cancel2faAction()}
        >
          Назад ко входу
        </button>
      </div>
    </form>
  )
}

export function LoginForm() {
  const [state, formAction] = useActionState<LoginState, FormData>(
    loginAction,
    {},
  )

  if (state.twofa) {
    return <TwofaStep method={state.twofa} />
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="identifier" className="text-sm font-medium">
          Email или логин
        </Label>
        <div className="relative">
          <User className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="identifier"
            name="identifier"
            type="text"
            autoComplete="username"
            placeholder="логин или email"
            required
            autoFocus
            className="h-12 rounded-xl pl-11 text-base"
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password" className="text-sm font-medium">
          Пароль
        </Label>
        <div className="relative">
          <Lock className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            required
            className="h-12 rounded-xl pl-11 text-base"
          />
        </div>
      </div>

      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3 text-sm text-destructive duration-300 animate-in fade-in slide-in-from-top-1"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      ) : null}

      <SubmitButton />
    </form>
  )
}
