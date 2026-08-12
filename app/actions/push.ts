'use server'

import { headers } from 'next/headers'
import { getSession } from '@/lib/auth'
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
  configured: boolean
  publicKey: string
}

/** Manager or curator may bootstrap push. */
async function requirePushUser() {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')
  if (session.role === 'manager' || session.role === 'curator') return session
  throw new Error('Forbidden')
}

export async function getPushConfigAction(): Promise<PushConfig> {
  await requirePushUser()
  return {
    configured: isPushConfigured(),
    publicKey: getVapidPublicKey(),
  }
}

export interface PushResult {
  ok: boolean
  message: string
}

export async function subscribePushAction(input: {
  endpoint: string
  p256dh: string
  auth: string
}): Promise<PushResult> {
  const session = await requirePushUser()
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

export async function unsubscribePushAction(
  endpoint: string,
): Promise<PushResult> {
  const session = await requirePushUser()
  if (!endpoint) return { ok: false, message: 'No endpoint.' }
  try {
    await removeSubscription(session.sub, endpoint)
    return { ok: true, message: 'Notifications disabled.' }
  } catch {
    return { ok: false, message: 'Could not remove subscription.' }
  }
}

export interface TestPushResult extends PushResult {
  needsResubscribe?: boolean
}

export async function sendTestPushAction(
  endpoint?: string,
): Promise<TestPushResult> {
  const session = await requirePushUser()
  if (!isPushConfigured()) {
    return { ok: false, message: 'Push не настроен на сервере.' }
  }

  const payload = {
    title: 'Omnidesk',
    body: 'Тестовое уведомление — push работает.',
    url: session.role === 'curator' ? '/curator' : '/app/inbox',
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
  publicKey: string
  devices: SubscriptionInfo[]
}

export async function getPushDiagnosticsAction(): Promise<PushDiagnostics> {
  const session = await requirePushUser()
  const configured = isPushConfigured()
  let devices: SubscriptionInfo[] = []
  if (configured) {
    devices = await listManagerSubscriptions(session.sub).catch(() => [])
  }
  return { configured, publicKey: getVapidPublicKey(), devices }
}
