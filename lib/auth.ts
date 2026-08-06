import bcrypt from 'bcryptjs'
import { createHash, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getManagerAuthState } from './data'
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  verifySession,
} from './session'
import type { SessionUser } from './types'

/* ------------------------------ Admin ------------------------------- */

/**
 * The admin account is configured purely via environment variables — no admin
 * row is stored in the database. Set ADMIN_EMAIL and ADMIN_PASSWORD on your VPS.
 * If either is unset, admin login is disabled (no insecure defaults).
 */
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

/**
 * Admin login (like managers) can be by email OR a short login. The login
 * defaults to the ADMIN_EMAIL local-part (admin@site.com -> "admin") but can be
 * overridden with ADMIN_USERNAME.
 */
const ADMIN_USERNAME = (
  process.env.ADMIN_USERNAME ||
  ADMIN_EMAIL.split('@')[0] ||
  ''
)
  .trim()
  .toLowerCase()

/**
 * Constant-time string comparison that does not leak length via early return.
 * Both sides are SHA-256 hashed first so `timingSafeEqual` always receives
 * equal-length buffers regardless of input length.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export function verifyAdminCredentials(
  identifier: string,
  password: string,
): boolean {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return false
  const id = identifier.trim().toLowerCase()
  // Match either the full email or the short login. Both comparisons run so
  // timing does not reveal which form was used.
  const emailOk = safeEqual(id, ADMIN_EMAIL)
  const usernameOk = ADMIN_USERNAME ? safeEqual(id, ADMIN_USERNAME) : false
  const passwordOk = safeEqual(password, ADMIN_PASSWORD)
  return (emailOk || usernameOk) && passwordOk
}

/* ---------------------------- Passwords ----------------------------- */

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function comparePassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

/* ----------------------------- Session ------------------------------ */

export async function startSession(user: SessionUser): Promise<void> {
  const token = await signSession(user)
  const store = await cookies()
  store.set(SESSION_COOKIE, token, sessionCookieOptions)
}

export async function endSession(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}

export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies()
  const session = await verifySession(store.get(SESSION_COOKIE)?.value)
  if (!session) return null

  // Admin sessions are env-backed and have no DB row to validate against.
  if (session.role === 'admin') return session

  // Managers AND curators live in the managers table and are validated against
  // the live DB on every request so that a password change or block revokes the
  // JWT immediately instead of waiting for its 7-day expiry.
  if (session.role === 'manager' || session.role === 'curator') {
    const state = await getManagerAuthState(session.sub)
    if (!state) return null
    if (state.status === 'blocked') return null
    if ((session.sv ?? 0) !== state.sessionVersion) return null
    return session
  }

  return null
}

export async function requireAdmin(): Promise<SessionUser> {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.role !== 'admin') redirect('/app')
  return session
}

export async function requireManager(): Promise<SessionUser> {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.role !== 'manager') {
    if (session.role === 'admin') redirect('/admin')
    // Curators are not managers — keep them out of the manager workspace.
    redirect('/login')
  }
  return session
}

export async function requireCurator(): Promise<SessionUser> {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.role !== 'curator') {
    if (session.role === 'admin') redirect('/admin')
    if (session.role === 'manager') redirect('/app')
    redirect('/login')
  }
  return session
}
