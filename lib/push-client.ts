import { subscribePushAction } from '@/app/actions/push'

/**
 * Browser-side Web Push helpers shared by the manager notification UI
 * (NotificationProvider and NotificationSettings). Keeping this in one place
 * avoids the two components drifting apart in how they create and persist a
 * push subscription.
 */

/** Convert a base64url VAPID public key into the Uint8Array the API expects. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

/**
 * Ensure this browser has a push subscription for the given VAPID public key,
 * then persist it on the server. Reuses an existing subscription when present,
 * otherwise creates one. Assumes the service worker is already registered and
 * notification permission has been granted by the caller.
 */
export async function ensurePushSubscription(
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
  return subscribePushAction({
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  })
}
