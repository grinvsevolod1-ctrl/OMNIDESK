'use client'

import { useRef, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { changeOwnPasswordAction } from '@/app/actions/account'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ChangePasswordForm() {
  const [pending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  function handle(formData: FormData) {
    startTransition(async () => {
      const res = await changeOwnPasswordAction(formData)
      if (res.ok) {
        toast.success(res.message)
        formRef.current?.reset()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <form
      ref={formRef}
      action={handle}
      className="flex max-w-sm flex-col gap-4"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="current">Текущий пароль</Label>
        <Input
          id="current"
          name="current"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="next">Новый пароль</Label>
        <Input
          id="next"
          name="next"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
        <p className="text-xs text-muted-foreground">Не менее 8 символов.</p>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Сохраняем…
            </>
          ) : (
            'Обновить пароль'
          )}
        </Button>
      </div>
    </form>
  )
}
