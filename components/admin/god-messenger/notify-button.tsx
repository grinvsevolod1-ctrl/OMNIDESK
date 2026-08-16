'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bell, BellOff, BellRing, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  godPushConfigAction,
  godSendTestPushAction,
  godUnsubscribePushAction,
} from '@/app/actions/admin-secret'
import { ensureGodPushSubscription } from '@/lib/god-push-client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type State = 'unknown' | 'unsupported' | 'off' | 'on'

/**
 * Enables Web Push for the god messenger on THIS device: registers the shared
 * service worker, asks for notification permission, subscribes and persists via
 * the god-scoped action. A long-press / second tap sends a test push.
 */
export function NotifyButton({ available }: { available: boolean }) {
  const [state, setState] = useState<State>('unknown')
  const [busy, setBusy] = useState(false)

  // Reflect current subscription state on mount.
  useEffect(() => {
    let cancelled = false
    async function detect() {
      if (
        typeof window === 'undefined' ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window)
      ) {
        if (!cancelled) setState('unsupported')
        return
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration()
        const sub = reg ? await reg.pushManager.getSubscription() : null
        if (!cancelled) setState(sub ? 'on' : 'off')
      } catch {
        if (!cancelled) setState('off')
      }
    }
    void detect()
    return () => {
      cancelled = true
    }
  }, [])

  const enable = useCallback(async () => {
    setBusy(true)
    try {
      const cfg = await godPushConfigAction()
      if (!cfg.configured || !cfg.publicKey) {
        toast.error('Push не настроен на сервере (VAPID).')
        return
      }
      if (!('serviceWorker' in navigator)) {
        toast.error('Браузер не поддерживает уведомления.')
        setState('unsupported')
        return
      }
      await navigator.serviceWorker.register('/sw.js')
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        toast.error('Разрешение на уведомления не выдано.')
        return
      }
      const res = await ensureGodPushSubscription(cfg.publicKey)
      if (res.ok) {
        setState('on')
        toast.success('Уведомления включены на этом устройстве.')
      } else {
        toast.error(res.message)
      }
    } catch {
      toast.error('Не удалось включить уведомления.')
    } finally {
      setBusy(false)
    }
  }, [])

  const disable = useCallback(async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = reg ? await reg.pushManager.getSubscription() : null
      if (sub) {
        await godUnsubscribePushAction(sub.endpoint)
        await sub.unsubscribe()
      }
      setState('off')
      toast.success('Уведомления выключены.')
    } catch {
      toast.error('Не удалось выключить уведомления.')
    } finally {
      setBusy(false)
    }
  }, [])

  const test = useCallback(async () => {
    const res = await godSendTestPushAction()
    if (res.ok) toast.success(res.message)
    else toast.error(res.message)
  }, [])

  if (state === 'unsupported' || !available) {
    return (
      <Button
        variant="ghost"
        size="icon"
        disabled
        className="size-9 text-muted-foreground"
        title="Уведомления недоступны"
      >
        <BellOff className="size-5" />
      </Button>
    )
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={busy || state === 'unknown'}
      onClick={() => {
        if (state === 'on') void test()
        else void enable()
      }}
      onDoubleClick={() => {
        if (state === 'on') void disable()
      }}
      className={cn('size-9', state === 'on' && 'text-primary')}
      title={
        state === 'on'
          ? 'Уведомления включены — нажмите для теста, двойной клик чтобы выключить'
          : 'Включить уведомления на этом устройстве'
      }
    >
      {busy || state === 'unknown' ? (
        <Loader2 className="size-5 animate-spin" />
      ) : state === 'on' ? (
        <BellRing className="size-5" />
      ) : (
        <Bell className="size-5" />
      )}
    </Button>
  )
}
