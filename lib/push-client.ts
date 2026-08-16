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
 * Byte-compare an existing subscription's server key with the current one.
 * Exported for the settings diagnostics panel: a mismatch here means every
 * push to this device is signed with a different key than the subscription
 * was created for, and the push service silently rejects them all.
 */
export function keyMatches(sub: PushSubscription, publicKey: string): boolean {
  const existing = sub.options?.applicationServerKey
  if (!existing) return false
  const a = new Uint8Array(existing)
  const b = urlBase64ToUint8Array(publicKey)
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * Ensure this browser has a push subscription for the given VAPID public key,
 * then persist it on the server. Reuses an existing subscription ONLY when it
 * was created with the SAME key: after a VAPID key rotation (typical after a
 * server move) the old subscription still exists in the browser but every
 * delivery to it fails with 403 VapidPkHashMismatch — silently, since the
 * push service rejects it server-side. That stale subscription must be
 * dropped and recreated, otherwise pushes "just stop" with no error anywhere.
 * Assumes the service worker is registered and permission has been granted.
 */
export async function ensurePushSubscription(
  publicKey: string,
): Promise<{ ok: boolean; message: string }> {
  if (!publicKey) {
    return { ok: false, message: 'Push-уведомления не настроены на сервере.' }
  }
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (sub && !keyMatches(sub, publicKey)) {
    // Key rotated — the old subscription can never be delivered to again.
    try {
      await sub.unsubscribe()
    } catch {
      /* best-effort: subscribe() below will fail loudly if this mattered */
    }
    sub = null
  }
  if (!sub) {
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
