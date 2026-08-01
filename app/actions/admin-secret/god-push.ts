'use server'

import { headers } from 'next/headers'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  getVapidPublicKey,
  isPushConfigured,
  removeGodSubscription,
  saveGodSubscription,
  sendPushToGod,
} from '@/lib/push'
import type { ActionResult } from './shared'

/**
 * Web Push actions for the god messenger (/wijegniwjgwjog/messages).
 *
 * Every action enforces the SAME two factors as the rest of the god panel:
 * `requireAdmin()` (logged-in admin) + `isGodUnlocked()` (secret passcode
 * cookie). Subscriptions are device-scoped, not user-scoped — the god messenger
 * is a single super-admin surface.
 */

async function assertGod(): Promise<boolean> {
  await requireAdmin()
  return isGodUnlocked()
}

export interface GodPushConfig {
  configured: boolean
  publicKey: string
}

/** Client bootstrap: is push available and what key to subscribe with. */
export async function godPushConfigAction(): Promise<GodPushConfig> {
  if (!(await assertGod())) return { configured: false, publicKey: '' }
  return {
    configured: isPushConfigured(),
    publicKey: getVapidPublicKey(),
  }
}

/** Store this device's push subscription for the god messenger. */
export async function godSubscribePushAction(input: {
  endpoint: string
  p256dh: string
  auth: string
}): Promise<ActionResult> {
  if (!(await assertGod())) return { ok: false, message: 'Нет доступа.' }
  if (!isPushConfigured())
    return { ok: false, message: 'Push не настроен на сервере.' }
  if (!input.endpoint || !input.p256dh || !input.auth)
    return { ok: false, message: 'Некорректная подписка.' }

  const ua = (await headers()).get('user-agent')
  try {
    await saveGodSubscription(
      { endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth },
      ua,
    )
    return { ok: true, message: 'Уведомления включены.' }
  } catch {
    return { ok: false, message: 'Не удалось сохранить подписку.' }
  }
}

/** Remove this device's subscription (notifications turned off). */
export async function godUnsubscribePushAction(
  endpoint: string,
): Promise<ActionResult> {
  if (!(await assertGod())) return { ok: false, message: 'Нет доступа.' }
  if (!endpoint) return { ok: false, message: 'Нет endpoint.' }
  try {
    await removeGodSubscription(endpoint)
    return { ok: true, message: 'Уведомления выключены.' }
  } catch {
    return { ok: false, message: 'Не удалось удалить подписку.' }
  }
}

/** Send a test push to every god device. */
export async function godSendTestPushAction(): Promise<ActionResult> {
  if (!(await assertGod())) return { ok: false, message: 'Нет доступа.' }
  if (!isPushConfigured())
    return { ok: false, message: 'Push не настроен на сервере.' }
  const { sent } = await sendPushToGod({
    title: 'Omnidesk Messages',
    body: 'Тестовое уведомление — push работает.',
    url: '/wijegniwjgwjog/messages',
    tag: 'god-test',
  })
  return sent > 0
    ? { ok: true, message: 'Тестовое уведомление отправлено.' }
    : { ok: false, message: 'Нет активных устройств.' }
}
