import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Tests for the admin session-version mechanism (lib/admin-session.ts).
 *
 * The module derives a version fingerprint from the admin credential material
 * in the environment, so we snapshot/restore the relevant env vars and
 * re-import the module per test (it computes lazily, but env changes between
 * calls must be reflected — these tests document that contract).
 */

const ENV_KEYS = [
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'ADMIN_PASSWORD_HASH',
  'ADMIN_SESSION_NONCE',
] as const

let saved: Record<string, string | undefined>

async function freshModule() {
  // Bust the module cache so the version reflects the CURRENT env, the same
  // way a process restart does in production.
  vi.resetModules()
  return await import('./admin-session')
}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('adminSessionVersion', () => {
  it('is stable for identical credential material', async () => {
    process.env.ADMIN_EMAIL = 'a@b.c'
    process.env.ADMIN_PASSWORD_HASH = '$2a$12$hash'
    delete process.env.ADMIN_PASSWORD
    delete process.env.ADMIN_SESSION_NONCE
    const m1 = await freshModule()
    const m2 = await freshModule()
    expect(m1.adminSessionVersion()).toBe(m2.adminSessionVersion())
  })

  it('changes when the password hash rotates', async () => {
    process.env.ADMIN_EMAIL = 'a@b.c'
    process.env.ADMIN_PASSWORD_HASH = '$2a$12$hash-one'
    const v1 = (await freshModule()).adminSessionVersion()
    process.env.ADMIN_PASSWORD_HASH = '$2a$12$hash-two'
    const v2 = (await freshModule()).adminSessionVersion()
    expect(v1).not.toBe(v2)
  })

  it('changes when ADMIN_SESSION_NONCE is bumped (force logout)', async () => {
    process.env.ADMIN_EMAIL = 'a@b.c'
    process.env.ADMIN_PASSWORD_HASH = '$2a$12$hash'
    delete process.env.ADMIN_SESSION_NONCE
    const v1 = (await freshModule()).adminSessionVersion()
    process.env.ADMIN_SESSION_NONCE = 'rotate-1'
    const v2 = (await freshModule()).adminSessionVersion()
    expect(v1).not.toBe(v2)
  })

  it('changes when the admin email changes', async () => {
    process.env.ADMIN_PASSWORD_HASH = '$2a$12$hash'
    process.env.ADMIN_EMAIL = 'first@b.c'
    const v1 = (await freshModule()).adminSessionVersion()
    process.env.ADMIN_EMAIL = 'second@b.c'
    const v2 = (await freshModule()).adminSessionVersion()
    expect(v1).not.toBe(v2)
  })
})

describe('isAdminSessionCurrent', () => {
  it('accepts a token carrying the current version', async () => {
    process.env.ADMIN_EMAIL = 'a@b.c'
    process.env.ADMIN_PASSWORD_HASH = '$2a$12$hash'
    const m = await freshModule()
    expect(m.isAdminSessionCurrent(m.adminSessionVersion())).toBe(true)
  })

  it('rejects a token from before a credential rotation', async () => {
    process.env.ADMIN_EMAIL = 'a@b.c'
    process.env.ADMIN_PASSWORD_HASH = '$2a$12$old'
    const vOld = (await freshModule()).adminSessionVersion()
    process.env.ADMIN_PASSWORD_HASH = '$2a$12$new'
    const m = await freshModule()
    expect(m.isAdminSessionCurrent(vOld)).toBe(false)
  })

  it('rejects legacy tokens without a version claim', async () => {
    process.env.ADMIN_EMAIL = 'a@b.c'
    process.env.ADMIN_PASSWORD_HASH = '$2a$12$hash'
    const m = await freshModule()
    expect(m.isAdminSessionCurrent(undefined)).toBe(false)
    expect(m.isAdminSessionCurrent(0)).toBe(false)
  })
})
