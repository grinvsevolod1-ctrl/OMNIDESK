'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Loader2, Lock, User } from 'lucide-react'
import { loginAction, type LoginState } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function SubmitButton() {
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
        'Войти'
      )}
    </Button>
  )
}

export function LoginForm() {
  const [state, formAction] = useActionState<LoginState, FormData>(
    loginAction,
    {},
  )

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
