'use client'

import { useRef, useState, useTransition } from 'react'
import {
  Check,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  MonitorSmartphone,
} from 'lucide-react'
import { toast } from 'sonner'
import { changeOwnPasswordAction } from '@/app/actions/account'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/** Живая оценка надёжности: 0..4 (длина, регистр, цифра, спецсимвол). */
function scorePassword(pw: string): number {
  if (!pw) return 0
  let score = 0
  if (pw.length >= 8) score += 1
  if (pw.length >= 12) score += 1
  if (/[a-zа-яё]/.test(pw) && /[A-ZА-ЯЁ]/.test(pw)) score += 1
  if (/\d/.test(pw) && /[^a-zA-Zа-яА-ЯёЁ0-9]/.test(pw)) score += 1
  return score
}

const STRENGTH: Record<number, { label: string; cls: string }> = {
  0: { label: '', cls: '' },
  1: { label: 'Слабый', cls: 'bg-destructive' },
  2: { label: 'Средний', cls: 'bg-amber-500' },
  3: { label: 'Хороший', cls: 'bg-emerald-500' },
  4: { label: 'Отличный', cls: 'bg-emerald-500' },
}

function PasswordInput({
  id,
  name,
  autoComplete,
  minLength,
  onChange,
}: {
  id: string
  name: string
  autoComplete: string
  minLength?: number
  onChange?: (value: string) => void
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        minLength={minLength}
        required
        className="pr-10"
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
        tabIndex={-1}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  )
}

export function ChangePasswordForm({ email }: { email?: string }) {
  const [pending, startTransition] = useTransition()
  const [next, setNext] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  const score = scorePassword(next)
  const strength = STRENGTH[score]

  const checks: { ok: boolean; label: string }[] = [
    { ok: next.length >= 8, label: 'Не менее 8 символов' },
    {
      ok: /[a-zа-яё]/.test(next) && /[A-ZА-ЯЁ]/.test(next),
      label: 'Строчные и заглавные буквы',
    },
    { ok: /\d/.test(next), label: 'Хотя бы одна цифра' },
  ]

  function handle(formData: FormData) {
    startTransition(async () => {
      const res = await changeOwnPasswordAction(formData)
      if (res.ok) {
        toast.success(res.message)
        formRef.current?.reset()
        setNext('')
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <form
      ref={formRef}
      action={handle}
      className="flex max-w-md flex-col gap-5"
    >
      {/* Скрытый логин: менеджеры паролей и скринридеры привязывают пароль
          к учётке (см. предупреждение Chrome о password-формах). */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={email ?? ''}
        readOnly
        hidden
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor="current">Текущий пароль</Label>
        <PasswordInput
          id="current"
          name="current"
          autoComplete="current-password"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="next">Новый пароль</Label>
        <PasswordInput
          id="next"
          name="next"
          autoComplete="new-password"
          minLength={8}
          onChange={setNext}
        />

        {/* Индикатор надёжности: 4 сегмента + подпись */}
        {next.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4].map((step) => (
                <span
                  key={step}
                  className={cn(
                    'h-1 flex-1 rounded-full transition-colors',
                    score >= step ? strength.cls : 'bg-muted',
                  )}
                />
              ))}
              <span className="w-16 text-right text-xs text-muted-foreground">
                {strength.label}
              </span>
            </div>
          </div>
        ) : null}

        <ul className="mt-1 flex flex-col gap-1">
          {checks.map((c) => (
            <li
              key={c.label}
              className={cn(
                'flex items-center gap-2 text-xs transition-colors',
                c.ok ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'flex size-3.5 items-center justify-center rounded-full border transition-colors',
                  c.ok
                    ? 'border-emerald-500/50 bg-emerald-500/10'
                    : 'border-border',
                )}
              >
                {c.ok ? <Check className="size-2.5" /> : null}
              </span>
              {c.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3.5 py-3">
        <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          После смены пароля все остальные устройства будут разлогинены, а
          доверенные устройства снова спросят код 2FA. Текущая сессия
          останется активной.
        </p>
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Сохраняем…
            </>
          ) : (
            <>
              <LockKeyhole className="size-4" />
              Обновить пароль
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
