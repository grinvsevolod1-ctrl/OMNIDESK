import 'server-only'
import { createHash, timingSafeEqual } from 'crypto'
import { jwtVerify, SignJWT } from 'jose'
import { cookies } from 'next/headers'
import { getAuthSecret } from './session'

/**
 * Standalone passcode gate for the god messenger (`/wijegniwjgwjog/messages`).
 *
 * Unlike `god-gate`, this is COMPLETELY INDEPENDENT of admin login and the god
 * panel unlock: the messenger PWA is meant to open on a phone with just its own
 * password — no Omnidesk admin session, no `SECRET_PANEL_PASSWORD`. Entering the
 * passcode sets a long-lived (30d, phone-friendly) HMAC-signed httpOnly cookie;
 * the passcode itself is never stored client-side.
 *
 * The passcode comes EXCLUSIVELY from the `MESSENGER_PASSWORD` env var. There is
 * deliberately no hardcoded fallback: if the variable is not set, the gate is
 * fail-closed and nobody can unlock the messenger.
 */

export const MESSENGER_COOKIE = 'omnidesk_msg'
const MESSENGER_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

const MESSENGER_PASSWORD = process.env.MESSENGER_PASSWORD || ''

/** True when the messenger passcode is configured on the server. */
export function isMessengerPasswordConfigured(): boolean {
  return MESSENGER_PASSWORD.length > 0
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

export function verifyMessengerPasscode(passcode: string): boolean {
  if (!MESSENGER_PASSWORD) return false
  return safeEqual(passcode, MESSENGER_PASSWORD)
}

/** Mint the signed unlock token to store in the cookie. */
export async function signMessengerToken(): Promise<string> {
  return new SignJWT({ scope: 'messenger' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MESSENGER_MAX_AGE}s`)
    .sign(getAuthSecret())
}

/**
 * Whether the current request holds a valid messenger unlock cookie. This is
 * the ONLY factor for the messenger — no admin/god fallback here.
 */
export async function isMessengerUnlocked(): Promise<boolean> {
  const store = await cookies()
  const token = store.get(MESSENGER_COOKIE)?.value
  if (!token) return false
  try {
    const { payload } = await jwtVerify(token, getAuthSecret())
    return payload.scope === 'messenger'
  } catch {
    return false
  }
}

export const messengerCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: MESSENGER_MAX_AGE,
}
