import { godSubscribePushAction } from '@/app/actions/admin-secret'
import { urlBase64ToUint8Array } from './push-client'

/**
 * Browser-side Web Push helper for the god messenger. Mirrors
 * ensurePushSubscription() from push-client.ts, but persists the subscription
 * through the god-scoped action (device-scoped, passcode-gated) instead of the
 * manager one. Assumes the service worker is registered and permission granted.
 */
export async function ensureGodPushSubscription(
  publicKey: string,
): Promise<{ ok: boolean; message: string }> {
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    if (!publicKey) {
      return { ok: false, message: 'Push-уведомления не настроены на сервере.' }
    }
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  }
  const json = sub.toJSON() as {
    endpoint?: string
    keys?: { p256dh?: string; auth?: string }
  }
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, message: 'Не удалось прочитать данные подписки.' }
  }
  return godSubscribePushAction({
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  })
}
