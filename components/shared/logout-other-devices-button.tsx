'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { logoutOtherDevicesAction } from '@/app/actions/sessions'

/** Кнопка «Разлогинить все устройства» для вкладки «Сессии». */
export function LogoutOtherDevicesButton() {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  function handleClick() {
    setBusy(true)
    ;(async () => {
      try {
        const res = await logoutOtherDevicesAction()
        if (res.ok) {
          toast.success(res.message)
          router.refresh()
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось разлогинить устройства')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <Button
      variant="outline"
      className="shrink-0 gap-1.5 bg-transparent"
      disabled={busy}
      onClick={handleClick}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <LogOut className="size-4" />
      )}
      Разлогинить все устройства
    </Button>
  )
}
