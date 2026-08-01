'use server'

import { cookies, headers } from 'next/headers'
import {
  MESSENGER_COOKIE,
  messengerCookieOptions,
  signMessengerToken,
  verifyMessengerPasscode,
} from '@/lib/messenger-gate'
import { rateLimit } from '@/lib/rate-limit'

export interface MessengerUnlockResult {
  ok: boolean
  message: string
}

/**
 * Verify the standalone messenger passcode and, on success, set the unlock
 * cookie. This is the ONLY auth for `/wijegniwjgwjog/messages` — no admin login
 * is involved. Rate-limited per client IP since there is no user identity to
 * key on.
 */
export async function messengerUnlockAction(
  passcode: string,
): Promise<MessengerUnlockResult> {
  const hdrs = await headers()
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    hdrs.get('x-real-ip') ||
    'unknown'

  const rl = await rateLimit(`messenger-unlock:${ip}`, 8, 5 * 60_000)
  if (!rl.allowed)
    return {
      ok: false,
      message: `Слишком много попыток. Повторите через ${rl.retryAfterSec} с.`,
    }

  if (!verifyMessengerPasscode((passcode || '').trim()))
    return { ok: false, message: 'Неверный пароль' }

  const store = await cookies()
  store.set(MESSENGER_COOKIE, await signMessengerToken(), messengerCookieOptions)
  return { ok: true, message: 'Доступ открыт' }
}

/** Sign out of the messenger on this device (clears the unlock cookie). */
export async function messengerLockAction(): Promise<void> {
  const store = await cookies()
  store.delete(MESSENGER_COOKIE)
}
