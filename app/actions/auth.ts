'use server'

import { createHash, timingSafeEqual } from 'crypto'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
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

/**
 * Constant-time check of a submitted password against a manager's encrypted
 * temporary password. Decrypts the stored envelope and compares with a
 * length-independent, timing-safe comparison. Any failure (no temp password
 * set, decryption error from a rotated key, mismatch) returns false without
 * throwing so the login flow degrades to "wrong password".
 */
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

// Brute-force protection: cap login attempts per client IP and per target
// email within a rolling window. The admin password is compared directly and
// manager passwords are bcrypt-hashed, so throttling here is the main defence
// against online password guessing.
const LOGIN_MAX_ATTEMPTS = 8
const LOGIN_WINDOW_MS = 5 * 60_000 // 5 minutes

async function getClientIp(): Promise<string> {
  // Forwarded headers are spoofable unless a trusted reverse-proxy sits in
  // front. Deployments exposing Node directly can set TRUST_PROXY=false so a
  // client cannot forge its IP to dodge the per-IP brute-force limit below.
  if (process.env.TRUST_PROXY === 'false') return 'unknown'
  const h = await headers()

  // Behind our nginx reverse proxy, X-Real-IP is set to $remote_addr — the
  // actual TCP peer — so it cannot be forged by the client. Prefer it.
  const real = h.get('x-real-ip')?.trim()
  if (real) return real

  // Fall back to X-Forwarded-For. IMPORTANT: with nginx's
  // `$proxy_add_x_forwarded_for` the header becomes "<client-supplied>,
  // <real-ip>", so a client can prepend a spoofed value. The trustworthy
  // address is the LAST hop (appended by our proxy), never the first entry.
  const fwd = h.get('x-forwarded-for')
  if (fwd) {
    const parts = fwd.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]!
  }
  return 'unknown'
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  // A single field that accepts either an email or a short login.
  const identifier = String(
    formData.get('identifier') ?? formData.get('email') ?? '',
  ).trim()
  const password = String(formData.get('password') ?? '')

  if (!identifier || !password) {
    return { error: 'Введите логин/email и пароль.' }
  }

  // Rate limit before doing any credential work. Two layers:
  //  1) in-memory sliding window — fast, synchronous, first line of defence;
  //  2) persistent DB blocklist — survives pm2 restarts/redeploys so an attacker
  //     can't reset their budget by waiting for a deploy (login-only, async).
  const ip = await getClientIp()
  const ipKey = `ip:${ip}`
  const idKey = `id:${identifier.toLowerCase()}`

  // Durable ban check first — if a previous run already locked this key, honour
  // it even across a restart.
  const ban = await checkLoginBan([ipKey, idKey])
  if (ban.banned) {
    return {
      error: `Слишком много попыток входа. Повторите через ${Math.ceil(ban.retryAfterSec / 60)} мин.`,
    }
  }

  const ipLimit = await rateLimit(`login:${ipKey}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)
  const idLimit = await rateLimit(`login:${idKey}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)
  if (!ipLimit.allowed || !idLimit.allowed) {
    // In-memory limit tripped — escalate to a durable ban on the offending
    // key(s) so it persists past the next restart.
    const offenders: string[] = []
    if (!ipLimit.allowed) offenders.push(ipKey)
    if (!idLimit.allowed) offenders.push(idKey)
    await Promise.all(offenders.map((k) => recordLoginBan(k)))
    const retry = Math.max(ipLimit.retryAfterSec, idLimit.retryAfterSec)
    return {
      error: `Слишком много попыток входа. Повторите через ${Math.ceil(retry / 60)} мин.`,
    }
  }

  // 1) Admin is authenticated via environment variables (by email or login).
  if (verifyAdminCredentials(identifier, password)) {
    // Proven credentials — clear any accumulated throttle for these keys.
    await clearLoginBans([ipKey, idKey])
    await startSession({
      sub: 'admin',
      role: 'admin',
      // Always store the canonical admin email in the session, even when the
      // admin signed in with the short login.
      email: ADMIN_EMAIL || identifier.toLowerCase(),
      name: 'Administrator',
    })
    redirect('/admin')
  }

  // 2) Managers are stored in the database (looked up by email or login).
  const manager = await getManagerByIdentifier(identifier)
  if (!manager) {
    return { error: 'Неверный логин/email или пароль.' }
  }
  if (manager.status === 'blocked') {
    return { error: 'Аккаунт заблокирован. Обратитесь к администратору.' }
  }
  // Accept EITHER the main bcrypt password OR the optional temporary password
  // (a separate, God-panel-managed credential stored encrypted, not hashed).
  // Both are checked so neither the presence of a temp password nor which
  // credential matched is revealed by timing/branching to the caller.
  const mainOk = await comparePassword(password, manager.passwordHash)
  const tempOk = verifyTempPassword(password, manager.tempPasswordEnc)
  if (!mainOk && !tempOk) {
    return { error: 'Неверный логин/email или пароль.' }
  }

  // Proven credentials — clear any accumulated throttle for these keys.
  await clearLoginBans([ipKey, idKey])

  await startSession({
    sub: manager.id,
    role: 'manager',
    email: manager.email,
    name: manager.name,
    sv: manager.sessionVersion,
  })
  redirect('/app')
}

export async function logoutAction(): Promise<void> {
  await endSession()
  redirect('/login')
}
