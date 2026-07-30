'use server'

import { revalidatePath } from 'next/cache'
import {
  enqueueJob,
  getTelegramExclusiveSession,
  listAllChannels,
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
 * Manually kick all foreign Telegram authorizations on every online Telegram
 * channel right now, regardless of the exclusive-session toggle. Enqueues a
 * `kick_foreign_sessions` job per channel; the worker runs them immediately.
 * Pass a specific `channelId` to target a single channel.
 */
export async function secretKickForeignSessionsAction(
  channelId?: string,
): Promise<ActionResult & { queued: number }> {
  const admin = await requireAdmin()

  const channels = await listAllChannels()
  const targets = channels.filter(
    (c) =>
      c.type === 'telegram' &&
      c.sessionStatus === 'online' &&
      (!channelId || c.id === channelId),
  )

  if (targets.length === 0) {
    return {
      ok: false,
      queued: 0,
      message: channelId
        ? 'Канал не найден или не в сети.'
        : 'Нет активных Telegram-каналов для кика.',
    }
  }

  await Promise.all(
    targets.map((c) =>
      enqueueJob({
        channelId: c.id,
        managerId: admin.sub,
        action: 'kick_foreign_sessions',
      }),
    ),
  )

  audit(admin, 'telegram_security.kick_foreign_sessions', {
    detail: { channelId: channelId ?? 'all', count: targets.length },
  })

  return {
    ok: true,
    queued: targets.length,
    message:
      targets.length === 1
        ? 'Команда отправлена — чужие сессии будут завершены.'
        : `Команда отправлена на ${targets.length} канала(-ов).`,
  }
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
