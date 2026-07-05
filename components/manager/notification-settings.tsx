'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BellRing, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  getPushConfigAction,
  sendTestPushAction,
  unsubscribePushAction,
} from '@/app/actions/push'
import { ensurePushSubscription } from '@/lib/push-client'

type State =
  | 'checking'
  | 'unsupported'
  | 'unconfigured'
  | 'default'
  | 'denied'
  | 'subscribed'

export function NotificationSettings() {
  const [state, setState] = useState<State>('checking')
  const [busy, setBusy] = useState(false)
  const publicKeyRef = useRef<string>('')

  const refresh = useCallback(async () => {
    if (
      typeof window === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('Notification' in window) ||
      !('PushManager' in window)
    ) {
      setState('unsupported')
      return
    }
    let config: { configured: boolean; publicKey: string }
    try {
      config = await getPushConfigAction()
    } catch {
      setState('unsupported')
      return
    }
    publicKeyRef.current = config.publicKey
    if (!config.configured) {
      setState('unconfigured')
      return
    }
    const perm = Notification.permission
    if (perm === 'denied') {
      setState('denied')
      return
    }
    const reg = await navigator.serviceWorker.ready.catch(() => null)
    const existing = reg ? await reg.pushManager.getSubscription() : null
    if (perm === 'granted' && existing) setState('subscribed')
    else setState('default')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const enable = useCallback(async () => {
    setBusy(true)
    try {
      await navigator.serviceWorker.register('/sw.js').catch(() => {})
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        toast.error('Разрешение не предоставлено.')
        await refresh()
        return
      }
      const res = await ensurePushSubscription(publicKeyRef.current)
      toast[res.ok ? 'success' : 'error'](res.message)
      await refresh()
    } catch {
      toast.error('Не удалось включить уведомления.')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const disable = useCallback(async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await unsubscribePushAction(sub.endpoint)
        await sub.unsubscribe().catch(() => {})
      }
      toast.success('Уведомления отключены на этом устройстве.')
      await refresh()
    } catch {
      toast.error('Не удалось отключить уведомления.')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const test = useCallback(async () => {
    setBusy(true)
    try {
      const res = await sendTestPushAction()
      toast[res.ok ? 'success' : 'error'](res.message)
    } finally {
      setBusy(false)
    }
  }, [])

  if (state === 'checking') {
    return (
      <p className="text-sm text-muted-foreground">Проверяем статус уведомлений…</p>
    )
  }
  if (state === 'unsupported') {
    return (
      <p className="text-sm text-muted-foreground">
        Этот браузер не поддерживает push-уведомления.
      </p>
    )
  }
  if (state === 'unconfigured') {
    return (
      <p className="text-sm text-muted-foreground">
        Push-уведомления ещё не настроены на сервере.
      </p>
    )
  }
  if (state === 'denied') {
    return (
      <p className="text-sm text-muted-foreground">
        Уведомления заблокированы для этого сайта. Разрешите их в настройках
        сайта в браузере и перезагрузите страницу.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={
            state === 'subscribed'
              ? 'inline-flex size-2 rounded-full bg-primary'
              : 'inline-flex size-2 rounded-full bg-muted-foreground'
          }
          aria-hidden="true"
        />
        <span className="text-muted-foreground">
          {state === 'subscribed'
            ? 'Включено на этом устройстве.'
            : 'Не включено на этом устройстве.'}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {state === 'subscribed' ? (
          <>
            <Button variant="outline" size="sm" onClick={test} disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Отправить тест
            </Button>
            <Button variant="ghost" size="sm" onClick={disable} disabled={busy}>
              Отключить на этом устройстве
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={enable} disabled={busy}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <BellRing className="size-4" />
            )}
            Включить уведомления
          </Button>
        )}
      </div>
    </div>
  )
}
