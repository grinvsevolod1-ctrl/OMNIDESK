'use server'

import { revalidatePath } from 'next/cache'
import {
  getTelegramExclusiveSession,
  setTelegramExclusiveSession,
} from '@/lib/data'
import { requireAdmin } from '@/lib/auth'
import { audit, ADMIN_PATH } from './shared'
import type { ActionResult } from './shared'

/**
 * Read the current value of the Telegram exclusive-session flag. Returned as
 * a plain boolean so the God-panel can render the toggle without a round-trip
 * inside the component (the Page RSC fetches it on load and passes it down as
 * a prop; this action is used for optimistic-update confirmation if needed).
 */
export async function secretGetTelegramExclusiveAction(): Promise<
  ActionResult & { enabled: boolean }
> {
  await requireAdmin()
  const enabled = await getTelegramExclusiveSession()
  return { ok: true, message: '', enabled }
}

/**
 * Flip the Telegram exclusive-session enforcement flag. When ON the worker
 * terminates every foreign Telegram authorization the moment it appears (and
 * retries periodically for sessions Telegram won't allow to be removed while
 * they're < 24 h old). Defaults to ON when unset.
 */
export async function secretSetTelegramExclusiveAction(
  enabled: boolean,
): Promise<ActionResult> {
  const admin = await requireAdmin()
  await setTelegramExclusiveSession(enabled)
  audit(admin, 'telegram_security.exclusive_session.set', { detail: { enabled } })
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: enabled
      ? 'Эксклюзивная сессия включена — чужие входы будут завершаться автоматически.'
      : 'Эксклюзивная сессия отключена.',
  }
}
