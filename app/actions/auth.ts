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
import { rateLimit } from '@/lib/rate-limit'

export interface LoginState {
  error?: string
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
  if (!mainOk && !tempOk) {
    return { error: 'Неверный логин/email или пароль.' }
  }

  await clearLoginBans([ipKey, idKey])

  const role = account.role === 'curator' ? 'curator' : 'manager'
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
