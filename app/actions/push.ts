'use server'

import { headers } from 'next/headers'
import { requireManager } from '@/lib/auth'
import {
  getVapidPublicKey,
  isPushConfigured,
  listManagerSubscriptions,
  removeSubscription,
  saveSubscription,
  sendPushToEndpoint,
  sendPushToManager,
  type SubscriptionInfo,
} from '@/lib/push'

export interface PushConfig {
  /** Whether the server has VAPID keys configured (push is available). */
  configured: boolean
  /** Public key for pushManager.subscribe(); empty when not configured. */
  publicKey: string
}

/** Client bootstrap: is push available and what key to subscribe with. */
export async function getPushConfigAction(): Promise<PushConfig> {
  await requireManager()
  return {
    configured: isPushConfigured(),
    publicKey: getVapidPublicKey(),
  }
}

export interface PushResult {
  ok: boolean
  message: string
}

/** Store the browser's push subscription for the signed-in manager. */
export async function subscribePushAction(input: {
  endpoint: string
  p256dh: string
  auth: string
}): Promise<PushResult> {
  const session = await requireManager()
  if (!isPushConfigured()) {
    return { ok: false, message: 'Push is not configured on the server.' }
  }
  if (!input.endpoint || !input.p256dh || !input.auth) {
    return { ok: false, message: 'Invalid subscription.' }
  }
  const ua = (await headers()).get('user-agent')
  try {
    await saveSubscription(
      session.sub,
      { endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth },
      ua,
    )
    return { ok: true, message: 'Notifications enabled.' }
  } catch {
    return { ok: false, message: 'Could not save subscription.' }
  }
}

/** Remove a subscription (manager turned notifications off on this device). */
export async function unsubscribePushAction(
  endpoint: string,
): Promise<PushResult> {
  const session = await requireManager()
  if (!endpoint) return { ok: false, message: 'No endpoint.' }
  try {
    await removeSubscription(session.sub, endpoint)
    return { ok: true, message: 'Notifications disabled.' }
  } catch {
    return { ok: false, message: 'Could not remove subscription.' }
  }
}

export interface TestPushResult extends PushResult {
  /**
   * Set when THIS device's subscription is broken server-side and the client
   * should re-subscribe (ensurePushSubscription) and retry the test.
   */
  needsResubscribe?: boolean
}

/**
 * Send a test push. When the client passes its own subscription endpoint the
 * test targets THAT device and reports its true status — the old broadcast
 * behavior said "sent" as long as ANY device got it, which is exactly how a
 * broken desktop kept looking fine while the phone received the test.
 */
export async function sendTestPushAction(
  endpoint?: string,
): Promise<TestPushResult> {
  const session = await requireManager()
  if (!isPushConfigured()) {
    return { ok: false, message: 'Push не настроен на сервере.' }
  }

  const payload = {
    title: 'Omnidesk',
    body: 'Тестовое уведомление — push работает.',
    url: '/app/inbox',
    tag: 'omnidesk-test',
  }

  if (endpoint) {
    const result = await sendPushToEndpoint(session.sub, endpoint, payload)
    switch (result) {
      case 'sent':
        return { ok: true, message: 'Тест отправлен на это устройство.' }
      case 'missing':
        return {
          ok: false,
          needsResubscribe: true,
          message:
            'Это устройство не зарегистрировано на сервере — переподписываем…',
        }
      case 'rejected':
        return {
          ok: false,
          needsResubscribe: true,
          message: 'Подписка устройства устарела — переподписываем…',
        }
      default:
        return {
          ok: false,
          message:
            'Push-сервис временно недоступен. Попробуйте ещё раз через минуту.',
        }
    }
  }

  const { sent } = await sendPushToManager(session.sub, payload)
  return sent > 0
    ? { ok: true, message: 'Тест отправлен.' }
    : { ok: false, message: 'Нет активных устройств.' }
}

export interface PushDiagnostics {
  configured: boolean
  /** Server VAPID public key (base64url) — client compares with its own. */
  publicKey: string
  devices: SubscriptionInfo[]
}

/**
 * Settings-page diagnostics: whether the server can push at all and which
 * devices it believes belong to this manager. Lets the client render an
 * honest per-device picture (this browser registered? key matching? when was
 * the device last confirmed?) instead of guessing from local state.
 */
export async function getPushDiagnosticsAction(): Promise<PushDiagnostics> {
  const session = await requireManager()
  const configured = isPushConfigured()
  let devices: SubscriptionInfo[] = []
  if (configured) {
    devices = await listManagerSubscriptions(session.sub).catch(() => [])
  }
  return { configured, publicKey: getVapidPublicKey(), devices }
}
