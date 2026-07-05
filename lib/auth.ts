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
  email: string,
  password: string,
): boolean {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return false
  const emailOk = safeEqual(email.trim().toLowerCase(), ADMIN_EMAIL)
  const passwordOk = safeEqual(password, ADMIN_PASSWORD)
  return emailOk && passwordOk
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
  if (session.role !== 'manager') return session

  // Managers are validated against the live DB on every request so that a
  // password change or block revokes the JWT immediately instead of waiting
  // for its 7-day expiry. A version mismatch / missing / blocked account all
  // collapse to "logged out" (requireManager then redirects to /login).
  const state = await getManagerAuthState(session.sub)
  if (!state) return null
  if (state.status === 'blocked') return null
  if ((session.sv ?? 0) !== state.sessionVersion) return null

  return session
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
  if (session.role !== 'manager') redirect('/admin')
  return session
}
