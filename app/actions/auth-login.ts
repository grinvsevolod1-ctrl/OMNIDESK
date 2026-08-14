'use server'

/**
 * Шаг 1 входа: пароль (+ выход). Второй шаг (2FA-код) — в auth-twofa.ts,
 * общие хелперы и типы состояний — в auth-shared.ts. Наружу всё
 * реэкспортируется барелем auth.ts.
 */
import { redirect } from 'next/navigation'
import { adminSessionVersion } from '@/lib/admin-session'
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
  createChallenge,
  generateLoginCode,
  getTwofaConfig,
  telegramBroadcast,
} from '@/lib/twofa'
import { setPendingTwofa } from '@/lib/twofa-pending'
import {
  getClientIp,
  getClientUa,
  verifyTempPassword,
  type LoginState,
} from './auth-shared'

const LOGIN_MAX_ATTEMPTS = 8
const LOGIN_WINDOW_MS = 5 * 60_000

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

  const ipLimit = await rateLimit(
    `login:${ipKey}`,
    LOGIN_MAX_ATTEMPTS,
    LOGIN_WINDOW_MS,
  )
  const idLimit = await rateLimit(
    `login:${idKey}`,
    LOGIN_MAX_ATTEMPTS,
    LOGIN_WINDOW_MS,
  )
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
      ? { ip, ua: await getClientUa(), master: true }
      : { ip, ua: await getClientUa(), temp: !mainOk && tempOk },
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

export async function logoutAction(): Promise<void> {
  await endSession()
  redirect('/login')
}
