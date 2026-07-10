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

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET

  if (secret && secret.length >= 16) {
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
