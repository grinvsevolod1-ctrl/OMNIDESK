'use server'

import {
  endImpersonation,
  readImpersonation,
  requireAdmin,
  roleHome,
  startImpersonation,
} from '@/lib/auth'
import { getManagerAuthState, getManagerById } from '@/lib/data'
import type { AccountRole, SessionUser } from '@/lib/types'
import { audit, type ActionResult } from './shared'

/** Result of starting an impersonation: carries the target's home route. */
export interface ImpersonationStartResult extends ActionResult {
  /** Where the new tab should navigate on success (role home). */
  home?: string
}

const IMPERSONATABLE: AccountRole[] = ['manager', 'curator', 'head', 'buyer']

const ROLE_LABEL: Record<AccountRole, string> = {
  manager: 'менеджера',
  curator: 'менеджера по кадрам',
  head: 'руководителя',
  buyer: 'медиабайера',
}

/**
 * Begin an admin «войти под сотрудником» session for a DB-backed staff account.
 *
 * SECURITY: requireAdmin() re-checks the caller on the server (a server action
 * is an independent POST endpoint). The grant is written to a SEPARATE 5-minute
 * cookie — the admin's own session is never touched — and it validates against
 * the live account state, so a blocked account can't be entered. The admin role
 * itself is never impersonatable (getManagerById only returns managers-table
 * rows, and verifyImpersonation additionally rejects role='admin').
 */
export async function startImpersonationAction(
  accountId: string,
): Promise<ImpersonationStartResult> {
  const admin = await requireAdmin()
  if (!accountId) return { ok: false, message: 'Не указан аккаунт' }

  const account = await getManagerById(accountId)
  if (!account) return { ok: false, message: 'Аккаунт не найден' }
  if (!IMPERSONATABLE.includes(account.role))
    return { ok: false, message: 'В этот аккаунт нельзя войти' }

  const state = await getManagerAuthState(accountId)
  if (!state) return { ok: false, message: 'Аккаунт не найден' }
  if (state.status === 'blocked')
    return { ok: false, message: 'Аккаунт заблокирован — вход невозможен' }

  const user: SessionUser = {
    sub: account.id,
    role: account.role,
    email: account.email,
    name: account.name,
    sv: state.sessionVersion,
  }
  await startImpersonation(user, admin.sub)

  audit(admin, 'account.impersonate.start', {
    targetId: account.id,
    summary: `Вход под аккаунтом «${account.name}» (${ROLE_LABEL[account.role]})`,
    detail: { role: account.role, email: account.email },
  })

  return {
    ok: true,
    message: `Сессия открыта: ${account.name}`,
    home: roleHome(account.role),
  }
}

/**
 * End the current impersonation and restore the admin's own session. Callable
 * from the impersonated (staff) context — it only removes the temporary cookie,
 * which can never escalate privileges (the real admin session lives in a
 * separate, untouched cookie).
 */
export async function stopImpersonationAction(): Promise<ActionResult> {
  const current = await readImpersonation()
  await endImpersonation()
  if (current) {
    // Best-effort audit; the acting principal is the originating admin id.
    audit(
      { sub: current.by, role: 'admin', email: '', name: 'admin' },
      'account.impersonate.stop',
      { targetId: current.user.sub, detail: { role: current.user.role } },
    )
  }
  return { ok: true, message: 'Вы вернулись в администратора' }
}
