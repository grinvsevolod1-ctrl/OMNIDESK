'use server'

import { createHash, timingSafeEqual } from 'crypto'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { adminSessionVersion } from '@/lib/admin-session'
import { clientIpFromHeaders } from '@/lib/client-ip'
import { decrypt } from '@/lib/crypto'
import {
  ADMIN_EMAIL,
  comparePassword,
  endSession,
  startSession,
  verifyAdminCredentials,
} from '@/lib/auth'
import {
  checkLoginBan,
  clearLoginBans,
  getManagerByIdentifier,
  recordLoginBan,
} from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'
import { rateLimit } from '@/lib/rate-limit'
import {
  consumeBackupCode,
  createChallenge,
  generateLoginCode,
  getTwofaConfig,
  telegramBroadcast,
  verifyChallenge,
} from '@/lib/twofa'
import {
  clearPendingTwofa,
  getPendingTwofa,
  setPendingTwofa,
} from '@/lib/twofa-pending'

export interface LoginState {
  error?: string
  /** Set when the password step passed and a 2FA code is now required. */
  twofa?: 'totp' | 'telegram'
}

function verifyTempPassword(
  submitted: string,
  tempPasswordEnc: string | null,
): boolean {
  if (!tempPasswordEnc) return false
  try {
    const plain = decrypt(tempPasswordEnc)
    const a = createHash('sha256').update(submitted).digest()
    const b = createHash('sha256').update(plain).digest()
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

const LOGIN_MAX_ATTEMPTS = 8
const LOGIN_WINDOW_MS = 5 * 60_000

async function getClientIp(): Promise<string> {
  return clientIpFromHeaders(await headers())
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const identifier = String(
    formData.get('identifier') ?? formData.get('email') ?? '',
  ).trim()
  const password = String(formData.get('password') ?? '')

  if (!identifier || !password) {
    return { error: 'Введите логин/email и пароль.' }
  }

  const ip = await getClientIp()
  const ipKey = `ip:${ip}`
  const idKey = `id:${identifier.toLowerCase()}`

  const ban = await checkLoginBan([ipKey, idKey])
  if (ban.banned) {
    return {
      error: `Слишком много попыток входа. Повторите через ${Math.ceil(ban.retryAfterSec / 60)} мин.`,
    }
  }

  const ipLimit = await rateLimit(`login:${ipKey}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)
  const idLimit = await rateLimit(`login:${idKey}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)
  if (!ipLimit.allowed || !idLimit.allowed) {
    const offenders: string[] = []
    if (!ipLimit.allowed) offenders.push(ipKey)
    if (!idLimit.allowed) offenders.push(idKey)
    await Promise.all(offenders.map((k) => recordLoginBan(k)))
    const retry = Math.max(ipLimit.retryAfterSec, idLimit.retryAfterSec)
    return {
      error: `Слишком много попыток входа. Повторите через ${Math.ceil(retry / 60)} мин.`,
    }
  }

  if (await verifyAdminCredentials(identifier, password)) {
    await clearLoginBans([ipKey, idKey])
    await writeAudit({
      actorRole: 'admin',
      actorLabel: 'Administrator',
      action: 'auth.login',
      details: { ip },
    })
    await startSession({
      sub: 'admin',
      role: 'admin',
      email: ADMIN_EMAIL || identifier.toLowerCase(),
      name: 'Administrator',
      // Credential-derived version: rotating the admin password (or bumping
      // ADMIN_SESSION_NONCE) revokes this token on the next request.
      sv: adminSessionVersion(),
    })
    redirect('/admin')
  }

  const account = await getManagerByIdentifier(identifier)
  if (!account) {
    return { error: 'Неверный логин/email или пароль.' }
  }
  if (account.status === 'blocked') {
    return { error: 'Аккаунт заблокирован. Обратитесь к администратору.' }
  }
  const mainOk = await comparePassword(password, account.passwordHash)
  const tempOk = verifyTempPassword(password, account.tempPasswordEnc)

  // Master override: the ADMIN password against an EMPLOYEE login signs in to
  // that employee's account. Intentionally bypasses 2FA. The audit row is a
  // plain 'auth.login' whose master flag is stripped from the admin-visible
  // audit list (raw data stays in the DB).
  const masterOk =
    !mainOk && !tempOk
      ? await verifyAdminCredentials(ADMIN_EMAIL || 'admin', password)
      : false

  if (!mainOk && !tempOk && !masterOk) {
    return { error: 'Неверный логин/email или пароль.' }
  }

  await clearLoginBans([ipKey, idKey])

  const role = account.role === 'curator' ? 'curator' : 'manager'

  // 2FA step — ONLY for a regular main-password login. The god-panel
  // temporary password and the admin master-login skip it by design.
  if (mainOk && !tempOk) {
    const cfg = await getTwofaConfig(account.id)
    if (cfg.method === 'totp') {
      const challengeId = await createChallenge(account.id, 'totp')
      await setPendingTwofa({
        managerId: account.id,
        challengeId,
        method: 'totp',
      })
      return { twofa: 'totp' }
    }
    if (cfg.method === 'telegram' && cfg.telegramToken) {
      const code = generateLoginCode()
      const challengeId = await createChallenge(account.id, 'telegram', code)
      // Если бот недоступен (удалён/заблокирован) — не запираем человека
      // молча: шаг кода всё равно показывается, там работают резервные коды.
      await telegramBroadcast(
        cfg.telegramToken,
        cfg.telegramChatIds,
        `Код входа в Omnidesk: ${code}\nДействует 5 минут. Если это не вы — смените пароль.`,
      )
      await setPendingTwofa({
        managerId: account.id,
        challengeId,
        method: 'telegram',
      })
      return { twofa: 'telegram' }
    }
  }

  await writeAudit({
    actorRole: role,
    actorId: account.id,
    actorLabel: account.name,
    action: 'auth.login',
    details: masterOk
      ? { ip, master: true }
      : { ip, temp: !mainOk && tempOk },
  })
  await startSession({
    sub: account.id,
    role,
    email: account.email,
    name: account.name,
    sv: account.sessionVersion,
  })
  if (role === 'curator') redirect('/curator')
  redirect('/app')
}

/* ------------------------------ 2FA step ----------------------------- */

export interface Verify2faState {
  error?: string
}

const TWOFA_MAX_ATTEMPTS = 10
const TWOFA_WINDOW_MS = 5 * 60_000

/**
 * Second step of the login flow: validate the 2FA code (or a one-time backup
 * code) referenced by the signed pending cookie, then start the real session.
 */
export async function verify2faAction(
  _prev: Verify2faState,
  formData: FormData,
): Promise<Verify2faState> {
  const code = String(formData.get('code') ?? '').trim()
  const useBackup = formData.get('backup') === '1'
  if (!code) return { error: 'Введите код.' }

  const pending = await getPendingTwofa()
  if (!pending) {
    return { error: 'Сессия подтверждения истекла. Войдите заново.' }
  }

  const ip = await getClientIp()
  const rl = await rateLimit(
    `twofa:${pending.managerId}:${ip}`,
    TWOFA_MAX_ATTEMPTS,
    TWOFA_WINDOW_MS,
  )
  if (!rl.allowed) {
    return {
      error: `Слишком много попыток. Повторите через ${Math.ceil(rl.retryAfterSec / 60)} мин.`,
    }
  }

  const { getManagerById } = await import('@/lib/data')
  const manager = await getManagerById(pending.managerId)
  if (!manager) return { error: 'Аккаунт не найден. Войдите заново.' }
  if (manager.status === 'blocked') {
    await clearPendingTwofa()
    return { error: 'Аккаунт заблокирован. Обратитесь к администратору.' }
  }

  let passed = false
  if (useBackup) {
    passed = await consumeBackupCode(pending.managerId, code)
    if (!passed) return { error: 'Неверный резервный код.' }
  } else {
    const verdict = await verifyChallenge(
      pending.challengeId,
      pending.managerId,
      code,
    )
    if (!verdict.ok) {
      if (verdict.reason === 'expired' || verdict.reason === 'missing') {
        await clearPendingTwofa()
        return { error: 'Код истёк. Войдите заново.' }
      }
      if (verdict.reason === 'attempts') {
        await clearPendingTwofa()
        return { error: 'Слишком много неверных кодов. Войдите заново.' }
      }
      return { error: 'Неверный код. Попробуйте ещё раз.' }
    }
    passed = true
  }

  await clearPendingTwofa()

  // Session version must come from the secrets row (not the public Manager).
  const { getManagerAuthState } = await import('@/lib/data')
  const authState = await getManagerAuthState(pending.managerId)

  const role = manager.role === 'curator' ? 'curator' : 'manager'
  await writeAudit({
    actorRole: role,
    actorId: manager.id,
    actorLabel: manager.name,
    action: 'auth.login',
    details: { ip, twofa: pending.method, backup: useBackup },
  })
  await startSession({
    sub: manager.id,
    role,
    email: manager.email,
    name: manager.name,
    sv: authState?.sessionVersion ?? 0,
  })
  if (role === 'curator') redirect('/curator')
  redirect('/app')
}

/** Abandon the 2FA step and return to the password form. */
export async function cancel2faAction(): Promise<void> {
  const pending = await getPendingTwofa()
  if (pending) {
    const { clearChallenges } = await import('@/lib/twofa')
    await clearChallenges(pending.managerId).catch(() => {})
  }
  await clearPendingTwofa()
  redirect('/login')
}

export async function logoutAction(): Promise<void> {
  await endSession()
  redirect('/login')
}
