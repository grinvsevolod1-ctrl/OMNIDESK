'use server'

import { headers } from 'next/headers'
import { requireManager } from '@/lib/auth'
import {
  getVapidPublicKey,
  isPushConfigured,
  removeSubscription,
  saveSubscription,
  sendPushToManager,
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

/** Send a test push to the signed-in manager's devices. */
export async function sendTestPushAction(): Promise<PushResult> {
  const session = await requireManager()
  if (!isPushConfigured()) {
    return { ok: false, message: 'Push is not configured on the server.' }
  }
  const { sent } = await sendPushToManager(session.sub, {
    title: 'Omnidesk',
    body: 'Test notification — push is working.',
    url: '/app/inbox',
    tag: 'omnidesk-test',
  })
  return sent > 0
    ? { ok: true, message: 'Test notification sent.' }
    : { ok: false, message: 'No active devices to notify.' }
}
