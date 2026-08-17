'use client'

import { useRef, useState, useTransition } from 'react'
import { AtSign, Loader2, Mail, Save, User } from 'lucide-react'
import { toast } from 'sonner'
import { updateMyProfileAction } from '@/app/actions/account'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Самостоятельная правка профиля (имя, логин, email) для менеджера, куратора
 * и руководителя. Логин необязателен — вход возможен по email. После успеха
 * сервер перевыпускает cookie сессии, поэтому обновляем страницу, чтобы шапка
 * и identity-карточка подхватили новые имя/почту.
 */
export function ProfileForm({
  initialName,
  initialUsername,
  initialEmail,
}: {
  initialName: string
  initialUsername: string | null
  initialEmail: string
}) {
  const [pending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  const [name, setName] = useState(initialName)
  const [username, setUsername] = useState(initialUsername ?? '')
  const [email, setEmail] = useState(initialEmail)

  const dirty =
    name.trim() !== initialName.trim() ||
    username.trim() !== (initialUsername ?? '').trim() ||
    email.trim().toLowerCase() !== initialEmail.trim().toLowerCase()

  function handle(formData: FormData) {
    startTransition(async () => {
      const res = await updateMyProfileAction(formData)
      if (res.ok) {
        toast.success(res.message)
        // Имя/почта попадают в шапку и identity-карточку (серверные) —
        // обновляем маршрут, чтобы они перечитались.
        window.location.reload()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <form ref={formRef} action={handle} className="flex max-w-md flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="profile-name">Имя</Label>
        <div className="relative">
          <User className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="profile-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="pl-9"
            autoComplete="name"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="profile-username">Логин</Label>
        <div className="relative">
          <AtSign className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="profile-username"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="без логина — вход по email"
            className="pl-9"
            autoComplete="username"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Можно входить по логину вместо email. Разрешены латиница, цифры,
          точка, дефис и подчёркивание; минимум 3 символа. Оставьте пустым,
          чтобы входить только по email.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="profile-email">Email</Label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="profile-email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="pl-9"
            autoComplete="email"
          />
        </div>
      </div>

      <div>
        <Button type="submit" disabled={pending || !dirty}>
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Сохраняем…
            </>
          ) : (
            <>
              <Save className="size-4" />
              Сохранить профиль
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
