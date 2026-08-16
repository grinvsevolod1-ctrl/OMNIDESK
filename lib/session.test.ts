import { beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from './types'

let session: typeof import('./session')

beforeAll(async () => {
  // A strong (>= 16 char) secret so getSecret() uses it instead of the dev
  // fallback, and behaviour matches production signing.
  process.env.AUTH_SECRET = 'test-secret-value-that-is-long-enough-1234567890'
  session = await import('./session')
})

const baseUser: SessionUser = {
  sub: 'user-123',
  role: 'manager',
  email: 'm@example.com',
  name: 'Мария',
  sv: 3,
}

describe('signSession / verifySession', () => {
  it('round-trips a session user', async () => {
    const token = await session.signSession(baseUser)
    const decoded = await session.verifySession(token)
    expect(decoded).toEqual(baseUser)
  })

  it('returns null for an undefined token', async () => {
    expect(await session.verifySession(undefined)).toBeNull()
  })

  it('returns null for a garbage token', async () => {
    expect(await session.verifySession('not.a.jwt')).toBeNull()
  })

  it('returns null for a token signed with a different secret', async () => {
    const token = await session.signSession(baseUser)
    // Re-import under a different secret would require module isolation; instead
    // tamper with the signature segment to simulate a forged/foreign token.
    const parts = token.split('.')
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('aa') ? 'bb' : 'aa')
    expect(await session.verifySession(parts.join('.'))).toBeNull()
  })

  it('preserves the session version (sv) for revocation checks', async () => {
    const token = await session.signSession({ ...baseUser, sv: 42 })
    const decoded = await session.verifySession(token)
    expect(decoded?.sv).toBe(42)
  })

  it('defaults sv to 0 when absent', async () => {
    const token = await session.signSession({ ...baseUser, sv: undefined })
    const decoded = await session.verifySession(token)
    expect(decoded?.sv).toBe(0)
  })
})
