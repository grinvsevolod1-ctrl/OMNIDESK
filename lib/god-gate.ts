import 'server-only'
import { createHash, timingSafeEqual } from 'crypto'
import { jwtVerify, SignJWT } from 'jose'
import { cookies } from 'next/headers'
import { getAuthSecret } from './session'

/**
 * Second-factor gate for the god-mode console (`/wijegniwjgwjog`).
 *
 * `requireAdmin()` already protects the route, but this adds a SEPARATE secret
 * passcode on top: even a logged-in admin must enter `SECRET_PANEL_PASSWORD`
 * once to unlock the panel. Unlock is remembered via a short-lived, HMAC-signed
 * httpOnly cookie (12h) — no passcode is ever stored client-side.
 *
 * If `SECRET_PANEL_PASSWORD` is NOT configured, the gate stays open (the route
 * still requires admin) so a missing env var can never lock the owner out.
 */

export const GOD_COOKIE = 'omnidesk_god'
const GOD_MAX_AGE = 60 * 60 * 12 // 12h

const SECRET_PANEL_PASSWORD = process.env.SECRET_PANEL_PASSWORD || ''

/** True when the owner has configured a secret passcode for the panel. */
export function isGodPasscodeConfigured(): boolean {
  return SECRET_PANEL_PASSWORD.length > 0
}

/**
 * Constant-time comparison. Both sides are SHA-256 hashed first so
 * `timingSafeEqual` always gets equal-length buffers and no length leaks.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export function verifyGodPasscode(passcode: string): boolean {
  if (!SECRET_PANEL_PASSWORD) return false
  return safeEqual(passcode, SECRET_PANEL_PASSWORD)
}

/** Mint the signed unlock token to store in the cookie. */
export async function signGodToken(): Promise<string> {
  return new SignJWT({ scope: 'god' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${GOD_MAX_AGE}s`)
    .sign(getAuthSecret())
}

/**
 * Whether the current request may see the panel: either no passcode is
 * configured, or a valid unlock cookie is present.
 */
export async function isGodUnlocked(): Promise<boolean> {
  if (!isGodPasscodeConfigured()) return true
  const store = await cookies()
  const token = store.get(GOD_COOKIE)?.value
  if (!token) return false
  try {
    const { payload } = await jwtVerify(token, getAuthSecret())
    return payload.scope === 'god'
  } catch {
    return false
  }
}

export const godCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: GOD_MAX_AGE,
}
