import { jwtVerify, SignJWT } from 'jose'
import type { Role, SessionUser } from './types'

/**
 * Edge-safe session primitives (JWT sign/verify with `jose`).
 * Kept dependency-free of Node-only modules so it can be used inside
 * middleware (Edge runtime) as well as server actions / route handlers.
 */

export const SESSION_COOKIE = 'omnidesk_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

export function getAuthSecret(): Uint8Array {
  return getSecret()
}

// Warn about a weak (16–31 char) AUTH_SECRET once per process, not per request.
let warnedShortSecret = false

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET

  if (secret && secret.length >= 16) {
    // HS256 wants a key of >= 32 bytes; anything shorter materially weakens
    // the HMAC. We still ACCEPT 16–31 chars so a running deployment with an
    // older secret keeps booting (throwing here would brick the panel on the
    // next restart), but we complain loudly so it gets rotated:
    //   openssl rand -base64 32
    // NOTE: rotating AUTH_SECRET invalidates all outstanding sessions.
    if (secret.length < 32 && !warnedShortSecret) {
      warnedShortSecret = true
      console.warn(
        `[session] AUTH_SECRET is only ${secret.length} chars — below the 32+ ` +
          'recommended for HS256. Rotate it to a value from `openssl rand -base64 32` ' +
          '(this will log everyone out once).',
      )
    }
    return new TextEncoder().encode(secret)
  }

  // In production we NEVER fall back to a baked-in secret: doing so would let
  // anyone who has seen the source code forge an admin JWT. Fail loudly so the
  // deployment is fixed instead of running wide open.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SECRET is not set (or is too short). Generate a strong value with ' +
        '`openssl rand -base64 32` and set it in your environment before starting the app.',
    )
  }

  // Dev/preview only: allow the app to boot without configuration, but make the
  // insecurity obvious in the logs.
  console.warn(
    '[session] AUTH_SECRET is not set — using an INSECURE development fallback. ' +
      'Set AUTH_SECRET before deploying to production.',
  )
  return new TextEncoder().encode(
    'dev-only-insecure-secret-change-me-in-production-0000',
  )
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({
    role: user.role,
    email: user.email,
    name: user.name,
    // Session version: re-checked against the DB on every request so a
    // password change / block can revoke outstanding tokens immediately.
    sv: user.sv ?? 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecret())
}

export async function verifySession(
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSecret())
    if (!payload.sub || !payload.role) return null
    return {
      sub: payload.sub,
      role: payload.role as Role,
      email: (payload.email as string) ?? '',
      name: (payload.name as string) ?? '',
      sv: typeof payload.sv === 'number' ? payload.sv : 0,
    }
  } catch {
    return null
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_MAX_AGE,
}

/* --------------------------- Impersonation --------------------------- */

/**
 * Short-lived admin «войти под сотрудником» session, kept in a SEPARATE cookie
 * so the admin's own 7-day session is never overwritten: removing this cookie
 * (manually, or after its 5-minute expiry) instantly restores the admin.
 *
 * Security properties:
 *  - minted ONLY by an admin-guarded server action;
 *  - the JWT itself carries a 5-minute `exp`, so even a lingering cookie stops
 *    working server-side after the window — it is not just a client maxAge;
 *  - `imp:true` marks the token as an impersonation grant and `by` records the
 *    originating admin id for the audit trail and the on-screen banner;
 *  - it can never represent the admin role (only DB-backed staff accounts).
 */
export const IMPERSONATION_COOKIE = 'omnidesk_impersonation'
export const IMPERSONATION_MAX_AGE = 60 * 5 // 5 minutes

export async function signImpersonation(
  user: SessionUser,
  byAdminSub: string,
): Promise<string> {
  return new SignJWT({
    role: user.role,
    email: user.email,
    name: user.name,
    sv: user.sv ?? 0,
    imp: true,
    by: byAdminSub,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime(`${IMPERSONATION_MAX_AGE}s`)
    .sign(getSecret())
}

export async function verifyImpersonation(
  token: string | undefined,
): Promise<{ user: SessionUser; by: string } | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSecret())
    // Must be an impersonation grant for a non-admin subject, minted by a
    // known admin id. Anything else is treated as absent (fail-closed).
    if (!payload.sub || !payload.role || payload.imp !== true) return null
    if (payload.role === 'admin') return null
    const by = typeof payload.by === 'string' ? payload.by : ''
    if (!by) return null
    return {
      user: {
        sub: payload.sub,
        role: payload.role as Role,
        email: (payload.email as string) ?? '',
        name: (payload.name as string) ?? '',
        sv: typeof payload.sv === 'number' ? payload.sv : 0,
      },
      by,
    }
  } catch {
    return null
  }
}

export const impersonationCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: IMPERSONATION_MAX_AGE,
}
