'use server'

import { revalidatePath } from 'next/cache'
import {
  comparePassword,
  hashPassword,
  requireManager,
  startSession,
} from '@/lib/auth'
import {
  getManagerAuthState,
  getManagerByEmail,
  getManagerOnLunch,
  setManagerOnLunch,
  tryGoOnLunch,
  updateManagerPassword,
} from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'
import type { SimpleResult } from './account-shared'

/**
 * Toggle the calling manager's "on lunch" availability. While on lunch, NEW
 * conversations are routed (round-robin) to other available managers; existing
 * conversations stay put. Returns the resulting state so the UI stays in sync.
 */
export async function setLunchAction(
  onLunch: boolean,
): Promise<{ ok: boolean; onLunch: boolean; message: string }> {
  const session = await requireManager()

  if (onLunch) {
    // Atomic guard: check-and-set runs in ONE transaction under an advisory
    // lock (tryGoOnLunch), so simultaneous clicks are serialized and the last
    // available manager is always blocked. The previous two-query version
    // raced: everyone pressing "lunch" at the same minute passed the check
    // together and the whole team could walk out at once.
    let allowed: boolean
    try {
      allowed = await tryGoOnLunch(session.sub)
    } catch (err) {
      // Fail CLOSED for going on lunch: if we can't verify availability,
      // don't risk leaving the line unmanned.
      console.error('[panel] setLunchAction (go on lunch) failed:', err)
      return {
        ok: false,
        onLunch: false,
        message: 'Не удалось обновить статус.',
      }
    }
    if (!allowed) {
      return {
        ok: false,
        onLunch: false,
        message:
          'Вы сейчас единственный менеджер на линии. Дождитесь, пока вернётся кто-то ещё, прежде чем уходить на обед.',
      }
    }
  } else {
    // Coming BACK from lunch is always allowed — never trap a manager away.
    try {
      await setManagerOnLunch(session.sub, false)
    } catch (err) {
      console.error('[panel] setLunchAction (return) failed:', err)
      return {
        ok: false,
        onLunch: true,
        message: 'Не удалось обновить статус.',
      }
    }
  }
  // The inbox lists conversations for this manager; refresh after a change.
  revalidatePath('/app/inbox')
  return {
    ok: true,
    onLunch,
    message: onLunch
      ? 'Вы на обеде — новые диалоги уйдут другим менеджерам.'
      : 'Вы снова на линии.',
  }
}

/** Read the calling manager's current "on lunch" flag (for initial UI state). */
export async function getLunchStateAction(): Promise<boolean> {
  const session = await requireManager()
  return getManagerOnLunch(session.sub)
}

export async function changeOwnPasswordAction(
  formData: FormData,
): Promise<SimpleResult> {
  const session = await requireManager()
  const current = String(formData.get('current') ?? '')
  const next = String(formData.get('next') ?? '')

  if (next.length < 8) {
    return { ok: false, message: 'Новый пароль должен быть не короче 8 символов.' }
  }
  const manager = await getManagerByEmail(session.email)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }

  const ok = await comparePassword(current, manager.passwordHash)
  if (!ok) return { ok: false, message: 'Текущий пароль неверен.' }

  await updateManagerPassword(manager.id, await hashPassword(next))
  await writeAudit({
    actorRole: 'manager',
    actorId: manager.id,
    actorLabel: manager.name,
    action: 'account.password_change',
    entityType: 'manager',
    entityId: manager.id,
  })

  // updateManagerPassword bumps session_version, which would invalidate THIS
  // manager's own cookie. Re-issue the session with the fresh version so the
  // user who just changed their password stays signed in, while every other
  // outstanding session (e.g. on another device) is forced to re-authenticate.
  const fresh = await getManagerAuthState(manager.id)
  await startSession({
    sub: manager.id,
    role: 'manager',
    email: manager.email,
    name: manager.name,
    sv: fresh?.sessionVersion ?? 0,
  })

  return { ok: true, message: 'Пароль обновлён.' }
}
