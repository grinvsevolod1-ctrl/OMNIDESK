import { jwtVerify, SignJWT } from 'jose'
import { cookies } from 'next/headers'
import { getAuthSecret } from './session'

/**
 * Short-lived signed cookie carried between the password step and the 2FA
 * code step of the login flow. It is NOT a session: it only proves "this
 * browser passed the password check for manager X moments ago" and points at
 * the server-side challenge row. 5-minute TTL, HttpOnly, SameSite=Lax.
 */

const PENDING_COOKIE = 'omnidesk_2fa_pending'
const PENDING_TTL_S = 5 * 60

export interface PendingTwofa {
  managerId: string
  challengeId: string
  method: 'totp' | 'telegram'
}

export async function setPendingTwofa(data: PendingTwofa): Promise<void> {
  const token = await new SignJWT({
    cid: data.challengeId,
    m: data.method,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(data.managerId)
    .setIssuedAt()
    .setExpirationTime(`${PENDING_TTL_S}s`)
    .sign(getAuthSecret())
  const store = await cookies()
  store.set(PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: PENDING_TTL_S,
  })
}

export async function getPendingTwofa(): Promise<PendingTwofa | null> {
  const store = await cookies()
  const token = store.get(PENDING_COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getAuthSecret())
    if (!payload.sub || typeof payload.cid !== 'string') return null
    const method = payload.m === 'telegram' ? 'telegram' : 'totp'
    return {
      managerId: payload.sub,
      challengeId: payload.cid,
      method,
    }
  } catch {
    return null
  }
}

export async function clearPendingTwofa(): Promise<void> {
  const store = await cookies()
  store.delete(PENDING_COOKIE)
}
