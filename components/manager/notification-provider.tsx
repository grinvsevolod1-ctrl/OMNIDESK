'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { getPushConfigAction } from '@/app/actions/push'
import { ensurePushSubscription } from '@/lib/push-client'

export type PushSupport = 'checking' | 'ok' | 'unsupported' | 'ios-needs-install'
export type PushPermission = 'default' | 'denied' | 'granted'

interface NotificationState {
  support: PushSupport
  permission: PushPermission
  configured: boolean
  subscribed: boolean
  busy: boolean
  /** True only when notifications are fully active on this device. */
  ready: boolean
  /** True while we are still detecting capabilities (avoid flashing the gate). */
  loading: boolean
  enable: () => Promise<void>
}

const NotificationContext = createContext<NotificationState | null>(null)

export function useNotifications(): NotificationState {
  const ctx = useContext(NotificationContext)
  if (!ctx) {
    throw new Error('useNotifications must be used within <NotificationProvider>')
  }
  return ctx
}

function detectIosNeedsInstall(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const isIos = /iphone|ipad|ipod/i.test(ua)
  const isStandalone =
    (window.navigator as unknown as { standalone?: boolean }).standalone ===
      true || window.matchMedia('(display-mode: standalone)').matches
  return isIos && !isStandalone
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [support, setSupport] = useState<PushSupport>('checking')
  const [permission, setPermission] = useState<PushPermission>('default')
  const [configured, setConfigured] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const publicKeyRef = useRef<string>('')

  const doSubscribe = useCallback(async (): Promise<boolean> => {
    const res = await ensurePushSubscription(publicKeyRef.current)
    if (res.ok) {
      setSubscribed(true)
      return true
    }
    return false
  }, [])

  // Bootstrap: feature detection, server config, SW registration, current state.
  useEffect(() => {
    let cancelled = false
    async function init() {
      if (
        typeof window === 'undefined' ||
        !('serviceWorker' in navigator) ||
        !('Notification' in window) ||
        !('PushManager' in window)
      ) {
        if (!cancelled) {
          setSupport(
            detectIosNeedsInstall() ? 'ios-needs-install' : 'unsupported',
          )
        }
        return
      }

      let config: { configured: boolean; publicKey: string }
      try {
        config = await getPushConfigAction()
      } catch {
        if (!cancelled) setSupport('unsupported')
        return
      }
      if (cancelled) return
      setConfigured(config.configured)
      publicKeyRef.current = config.publicKey

      try {
        await navigator.serviceWorker.register('/sw.js')
      } catch {
        if (!cancelled) setSupport('unsupported')
        return
      }
      if (cancelled) return

      setSupport('ok')
      const perm = Notification.permission as PushPermission
      setPermission(perm)

      const reg = await navigator.serviceWorker.ready
      const existing = await reg.pushManager.getSubscription()
      if (cancelled) return
      setSubscribed(Boolean(existing))

      // Permission granted: ALWAYS re-sync with the server, even when a local
      // subscription exists. A browser-side subscription is only half the
      // story — the server may have pruned its row (VAPID 403 cleanup, DB
      // maintenance), leaving this device convinced it is subscribed while
      // the server has nowhere to send. That silent split-brain is exactly
      // "phone gets pushes, desktop doesn't": the phone re-subscribed later,
      // the desktop never did. ensurePushSubscription is idempotent — it
      // reuses a key-matching subscription, replaces a stale-key one, and
      // re-upserts the server row either way (a no-op when already in sync).
      if (perm === 'granted' && config.configured) {
        void doSubscribe().catch(() => {})
      }
    }
    void init()
    return () => {
      cancelled = true
    }
  }, [doSubscribe])

  const enable = useCallback(async () => {
    if (support === 'ios-needs-install' || support === 'unsupported') return
    setBusy(true)
    try {
      const perm = (await Notification.requestPermission()) as PushPermission
      setPermission(perm)
      if (perm === 'granted') {
        const ok = await doSubscribe()
        toast[ok ? 'success' : 'error'](
          ok
            ? 'Уведомления включены на этом устройстве.'
            : 'Не удалось завершить включение уведомлений.',
        )
      } else if (perm === 'denied') {
        toast.error(
          'Уведомления заблокированы. Включите их в настройках браузера.',
        )
      }
    } catch {
      toast.error('Не удалось включить уведомления.')
    } finally {
      setBusy(false)
    }
  }, [doSubscribe, support])

  const loading = support === 'checking'
  // When the server has no VAPID keys we cannot subscribe at all; treat the push
  // requirement as satisfied so a misconfigured server never locks managers out.
  const ready =
    (support === 'ok' && permission === 'granted' && subscribed) ||
    (support === 'ok' && !configured)

  const value: NotificationState = {
    support,
    permission,
    configured,
    subscribed,
    busy,
    ready,
    loading,
    enable,
  }

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  )
}
