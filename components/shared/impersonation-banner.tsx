'use client'

import { useState, useTransition } from 'react'
import { Loader2, LogOut, UserCog } from 'lucide-react'
import { toast } from 'sonner'
import { stopImpersonationAction } from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'

/**
 * Always-visible banner shown while an admin is «вошёл под сотрудником». It
 * makes the borrowed session unmistakable and offers a one-click return to the
 * admin. The actual privilege lives in an httpOnly cookie — this is only the
 * control surface; ending it simply drops that temporary cookie server-side.
 */
export function ImpersonationBanner({
  name,
  roleLabel,
}: {
  name: string
  roleLabel: string
}) {
  const [pending, startTransition] = useTransition()
  const [left, setLeft] = useState(false)

  function exit() {
    if (left) return
    setLeft(true)
    startTransition(async () => {
      try {
        const res = await stopImpersonationAction()
        if (res.ok) {
          toast.success(res.message)
          // Return to the god panel; the admin's own cookie resumes control.
          window.location.href = '/wijegniwjgwjog'
        } else {
          toast.error(res.message)
          setLeft(false)
        }
      } catch {
        toast.error('Не удалось выйти из сессии')
        setLeft(false)
      }
    })
  }

  return (
    <div className="sticky top-0 z-50 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning-foreground">
      <span className="flex items-center gap-2 font-medium text-foreground">
        <UserCog className="size-4 shrink-0 text-warning" />
        Режим администратора: вы вошли как {roleLabel.toLowerCase()}
        <span className="font-semibold">«{name}»</span>
      </span>
      <span className="text-xs text-muted-foreground">
        Сессия завершится автоматически через несколько минут.
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={exit}
        disabled={pending || left}
        className="ml-auto gap-1.5 border-warning/50"
      >
        {pending || left ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <LogOut className="size-3.5" />
        )}
        Выйти из сессии
      </Button>
    </div>
  )
}
