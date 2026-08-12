import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Integration tests for the credential layer behind the login flow.
 *
 * Two halves:
 *  1. Admin credentials (env-only, no DB) — verifyAdminCredentials with
 *     ADMIN_PASSWORD_HASH (bcrypt), the legacy plaintext fallback, and the
 *     session-version revocation that rides on those credentials.
 *  2. Manager credentials (DB-backed) — the manager auth-state lookup that
 *     getSession/proxy validate on every request, including the blocked-status
 *     and session-version revocation paths. Requires DATABASE_URL.
 */

const ENV_KEYS = [
  'ADMIN_EMAIL',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'ADMIN_PASSWORD_HASH',
  'ADMIN_SESSION_NONCE',
] as const

let savedEnv: Record<string, string | undefined>

async function freshAuth() {
  vi.resetModules()
  return await import('@/lib/auth')
}

describe('admin credential verification (env-only)', () => {
  beforeEach(() => {
    savedEnv = {}
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('accepts the correct password against ADMIN_PASSWORD_HASH', async () => {
    const bcrypt = (await import('bcryptjs')).default
    process.env.ADMIN_EMAIL = 'boss@corp.test'
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('correct horse', 10)
    delete process.env.ADMIN_PASSWORD
    const { verifyAdminCredentials } = await freshAuth()
    expect(await verifyAdminCredentials('boss@corp.test', 'correct horse')).toBe(true)
    expect(await verifyAdminCredentials('boss@corp.test', 'wrong')).toBe(false)
  })

  it('prefers the hash when both hash and plaintext are set', async () => {
    const bcrypt = (await import('bcryptjs')).default
    process.env.ADMIN_EMAIL = 'boss@corp.test'
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('hash-pw', 10)
    process.env.ADMIN_PASSWORD = 'plain-pw'
    const { verifyAdminCredentials } = await freshAuth()
    expect(await verifyAdminCredentials('boss@corp.test', 'hash-pw')).toBe(true)
    // The plaintext var must be IGNORED when a hash is configured.
    expect(await verifyAdminCredentials('boss@corp.test', 'plain-pw')).toBe(false)
  })

  it('falls back to legacy plaintext comparison when no hash is set', async () => {
    process.env.ADMIN_EMAIL = 'boss@corp.test'
    process.env.ADMIN_PASSWORD = 'legacy-pw'
    delete process.env.ADMIN_PASSWORD_HASH
    const { verifyAdminCredentials } = await freshAuth()
    expect(await verifyAdminCredentials('boss@corp.test', 'legacy-pw')).toBe(true)
    expect(await verifyAdminCredentials('boss@corp.test', 'nope')).toBe(false)
  })

  it('refuses everything when no credentials are configured', async () => {
    delete process.env.ADMIN_PASSWORD
    delete process.env.ADMIN_PASSWORD_HASH
    process.env.ADMIN_EMAIL = 'boss@corp.test'
    const { verifyAdminCredentials } = await freshAuth()
    expect(await verifyAdminCredentials('boss@corp.test', '')).toBe(false)
    expect(await verifyAdminCredentials('boss@corp.test', 'anything')).toBe(false)
  })

  it('accepts the short username form as identifier', async () => {
    const bcrypt = (await import('bcryptjs')).default
    process.env.ADMIN_EMAIL = 'boss@corp.test'
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('pw', 10)
    const { verifyAdminCredentials } = await freshAuth()
    expect(await verifyAdminCredentials('boss', 'pw')).toBe(true)
    expect(await verifyAdminCredentials('someone-else', 'pw')).toBe(false)
  })

  it('rotating the password revokes outstanding admin session versions', async () => {
    const bcrypt = (await import('bcryptjs')).default
    process.env.ADMIN_EMAIL = 'boss@corp.test'
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('old-pw', 10)
    vi.resetModules()
    const before = (await import('@/lib/admin-session')).adminSessionVersion()

    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('new-pw', 10)
    vi.resetModules()
    const mod = await import('@/lib/admin-session')
    expect(mod.isAdminSessionCurrent(before)).toBe(false)
    expect(mod.isAdminSessionCurrent(mod.adminSessionVersion())).toBe(true)
  })
})

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe.skipIf(!HAS_DB)('manager auth state (DB-backed revocation)', () => {
  let query: typeof import('@/lib/db').query
  let closePool: typeof import('@/lib/db').closePool
  let managersMod: typeof import('@/lib/data/managers')
  let managerId: string

  beforeAll(async () => {
    ;({ query, closePool } = await import('@/lib/db'))
    managersMod = await import('@/lib/data/managers')
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const rows = await query<{ id: string }>(
      `INSERT INTO managers (name, email, password_hash)
       VALUES ('Login Test', $1, 'x') RETURNING id`,
      [`login-${stamp}@test.invalid`],
    )
    managerId = rows[0].id
  })

  afterAll(async () => {
    if (managerId) await query(`DELETE FROM managers WHERE id = $1`, [managerId])
    await closePool()
  })

  it('reports an active manager with its session version', async () => {
    managersMod.invalidateManagerAuthState(managerId)
    const state = await managersMod.getManagerAuthState(managerId)
    expect(state).not.toBeNull()
    expect(state!.status).toBe('active')
    expect(typeof state!.sessionVersion).toBe('number')
  })

  it('bumping session_version invalidates the previous version', async () => {
    managersMod.invalidateManagerAuthState(managerId)
    const before = await managersMod.getManagerAuthState(managerId)
    await query(
      `UPDATE managers SET session_version = session_version + 1 WHERE id = $1`,
      [managerId],
    )
    managersMod.invalidateManagerAuthState(managerId)
    const after = await managersMod.getManagerAuthState(managerId)
    expect(after!.sessionVersion).toBe(before!.sessionVersion + 1)
  })

  it('blocking a manager is reflected in auth state', async () => {
    await query(`UPDATE managers SET status = 'blocked' WHERE id = $1`, [managerId])
    managersMod.invalidateManagerAuthState(managerId)
    const state = await managersMod.getManagerAuthState(managerId)
    expect(state!.status).toBe('blocked')
    // Restore for other assertions.
    await query(`UPDATE managers SET status = 'active' WHERE id = $1`, [managerId])
    managersMod.invalidateManagerAuthState(managerId)
  })

  it('returns null for a nonexistent manager id', async () => {
    const state = await managersMod.getManagerAuthState(
      '00000000-0000-4000-8000-000000000000',
    )
    expect(state).toBeNull()
  })
})
