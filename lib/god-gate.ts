import 'server-only'
import { createHash, timingSafeEqual } from 'crypto'
import { jwtVerify, SignJWT } from 'jose'
import { cookies } from 'next/headers'
import { requireAdmin } from './auth'
import { getAuthSecret } from './session'

/**
 * Second-factor gate for the god-mode console (`/wijegniwjgwjog`).
 *
 * `requireAdmin()` already protects the route, but this adds a SEPARATE secret
 * passcode on top: even a logged-in admin must enter `SECRET_PANEL_PASSWORD`
 * once to unlock the panel. Unlock is remembered via a short-lived, HMAC-signed
 * httpOnly cookie (12h) — no passcode is ever stored client-side.
 *
 * FAIL-CLOSED: if `SECRET_PANEL_PASSWORD` is NOT configured, the gate is
 * LOCKED and cannot be unlocked at all. The console then renders a plain 404 —
 * indistinguishable from a route that does not exist — so nothing about the
 * panel is revealed to anyone, including a logged-in admin.
 *
 * RECOVERY: the owner can never be locked out permanently, because the
 * passcode lives in the server environment which only the owner controls.
 * To (re)gain access: set SECRET_PANEL_PASSWORD in the env file on the VPS,
 * restart the process (pm2 restart), open the console URL and enter the
 * passcode. Lost passcode = set a new value the same way. No in-band recovery
 * path exists by design — an attacker with panel/DB access cannot reopen the
 * gate; only someone with shell access to the server can.
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

/**
 * Credential fingerprint baked into every unlock token: a truncated SHA-256 of
 * the CURRENT passcode. Rotating SECRET_PANEL_PASSWORD changes the fingerprint,
 * so every previously issued cookie stops matching and the panel re-locks
 * immediately — without this, an old cookie stayed valid for up to 12h after a
 * rotation. Truncated to 16 hex chars: enough to make forgery infeasible
 * (the token is HMAC-signed anyway), short enough not to leak hash material.
 */
function passcodeFingerprint(): string {
  return createHash('sha256')
    .update(SECRET_PANEL_PASSWORD)
    .digest('hex')
    .slice(0, 16)
}

/** Mint the signed unlock token to store in the cookie. */
export async function signGodToken(): Promise<string> {
  return new SignJWT({ scope: 'god', pfp: passcodeFingerprint() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${GOD_MAX_AGE}s`)
    .sign(getAuthSecret())
}

// Emit the "no passcode configured" notice at most once per process so the
// fail-closed state (and its recovery path) is visible in logs — without
// spamming a line on every request.
let warnedNoPasscode = false
function warnFailClosedOnce(): void {
  if (warnedNoPasscode) return
  warnedNoPasscode = true
  console.warn(
    '[god-gate] SECRET_PANEL_PASSWORD is not set — the console is LOCKED ' +
      '(fail-closed) and its route serves 404. To enable access, set ' +
      'SECRET_PANEL_PASSWORD in the server env and restart the process.',
  )
}

/**
 * Whether the current request may see the panel: a passcode MUST be configured
 * AND a valid unlock cookie must be present. No passcode configured =
 * permanently locked (fail-closed); see the recovery notes above.
 */
export async function isGodUnlocked(): Promise<boolean> {
  if (!isGodPasscodeConfigured()) {
    warnFailClosedOnce()
    return false
  }
  const store = await cookies()
  const token = store.get(GOD_COOKIE)?.value
  if (!token) return false
  try {
    const { payload } = await jwtVerify(token, getAuthSecret())
    // Tokens minted before a passcode rotation carry the OLD fingerprint (or
    // none at all) and are rejected — rotating SECRET_PANEL_PASSWORD revokes
    // all outstanding unlock cookies instantly.
    return payload.scope === 'god' && payload.pfp === passcodeFingerprint()
  } catch {
    return false
  }
}

/**
 * Guard for the god-console JSON/SSE API routes (`/api/wijegniwjgwjog/*`).
 *
 * These endpoints back the same panel as the `/wijegniwjgwjog` page, so they
 * MUST enforce the same two factors — otherwise a logged-in admin could hit the
 * raw API and bypass the passcode the page requires. `requireAdmin()` handles
 * the first factor (and redirects a non-admin), then we require the unlock
 * cookie exactly like the page does. When no passcode is configured this
 * fails CLOSED in lockstep with `isGodUnlocked()`.
 *
 * Denial is a bare 404 — byte-identical in spirit to a route that does not
 * exist — so probing these paths (even as a logged-in admin) reveals nothing
 * about the panel. Returns the `Response` to short-circuit the handler, or
 * `null` when access is granted:
 *
 *   const denied = await guardGodApi()
 *   if (denied) return denied
 */
export async function guardGodApi(): Promise<Response | null> {
  await requireAdmin()
  if (!(await isGodUnlocked())) {
    return new Response('Not Found', { status: 404 })
  }
  return null
}

export const godCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: GOD_MAX_AGE,
}
