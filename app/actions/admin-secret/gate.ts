'use server'

import {
  revalidatePath,
} from 'next/cache'
import {
  cookies,
} from 'next/headers'
import {
  requireAdmin,
} from '@/lib/auth'
import {
  GOD_COOKIE,
  godCookieOptions,
  isGodPasscodeConfigured,
  signGodToken,
  verifyGodPasscode,
} from '@/lib/god-gate'
import {
  rateLimit,
} from '@/lib/rate-limit'
import {
  ADMIN_PATH,
  type ActionResult,
} from './shared'

export async function secretUnlockAction(passcode: string): Promise<ActionResult> {
  const admin = await requireAdmin()

  // Fail-closed AND indistinguishable: an unconfigured gate answers exactly
  // like a wrong passcode, so this action leaks nothing about server config.
  // The real state (and the recovery path) is visible only in server logs.
  if (!isGodPasscodeConfigured())
    return { ok: false, message: 'Неверный секретный пароль' }

  const rl = await rateLimit(`god-unlock:${admin.sub}`, 6, 5 * 60_000)
  if (!rl.allowed)
    return {
      ok: false,
      message: `Слишком много попыток. Повторите через ${rl.retryAfterSec} с.`,
    }

  if (!verifyGodPasscode((passcode || '').trim()))
    return { ok: false, message: 'Неверный секретный пароль' }

  const store = await cookies()
  store.set(GOD_COOKIE, await signGodToken(), godCookieOptions)
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Доступ открыт' }
}

/** Forget the unlock cookie — re-locks the panel until the passcode is re-entered. */
export async function secretLockAction(): Promise<void> {
  await requireAdmin()
  const store = await cookies()
  store.delete(GOD_COOKIE)
  revalidatePath(ADMIN_PATH)
}
