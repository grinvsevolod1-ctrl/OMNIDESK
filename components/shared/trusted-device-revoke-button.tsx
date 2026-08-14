'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { revokeTrustedDeviceAction } from '@/app/actions/sessions'

/** Кнопка «Забыть» у доверенного устройства во вкладке «Сессии». */
export function TrustedDeviceRevokeButton({ deviceId }: { deviceId: string }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  function handleClick() {
    setBusy(true)
    ;(async () => {
      try {
        const res = await revokeTrustedDeviceAction(deviceId)
        if (res.ok) {
          toast.success(res.message)
          router.refresh()
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось забыть устройство')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 gap-1 text-muted-foreground hover:text-destructive"
      disabled={busy}
      onClick={handleClick}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <X className="size-3.5" />
      )}
      Забыть
    </Button>
  )
}
