import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Integration test: audit log write/read path (migration 129).
 *
 *   1. writeAudit persists a row that listAudit returns with correct fields
 *   2. writeAudit NEVER throws, even against a broken query (fire-and-forget
 *      contract — an audit failure must not break the business action)
 *   3. listAudit action-prefix filter matches prefixes only
 *
 * Requires DATABASE_URL (real Postgres with migrations). Skipped otherwise.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe.skipIf(!HAS_DB)('audit log (migration 129)', () => {
  let query: typeof import('@/lib/db').query
  let closePool: typeof import('@/lib/db').closePool
  let writeAudit: typeof import('@/lib/data/audit').writeAudit
  let listAudit: typeof import('@/lib/data/audit').listAudit

  // Unique action namespace so this run never collides with real rows.
  const ns = `test.${Date.now()}.${Math.floor(Math.random() * 1e6)}`

  beforeAll(async () => {
    ;({ query, closePool } = await import('@/lib/db'))
    ;({ writeAudit, listAudit } = await import('@/lib/data/audit'))
  })

  afterAll(async () => {
    await query(`DELETE FROM audit_log WHERE action LIKE $1 || '%'`, [ns])
    await closePool()
  })

  it('persists and reads back an entry', async () => {
    await writeAudit({
      actorRole: 'manager',
      actorId: null,
      actorLabel: 'Integration Test',
      action: `${ns}.login`,
      entityType: 'manager',
      entityId: 'test-entity',
      details: { ip: '127.0.0.1' },
    })

    const page = await listAudit({
      limit: 10,
      offset: 0,
      actionPrefix: ns,
    })
    expect(page.total).toBe(1)
    expect(page.rows[0].actorLabel).toBe('Integration Test')
    expect(page.rows[0].action).toBe(`${ns}.login`)
    expect(page.rows[0].details).toEqual({ ip: '127.0.0.1' })
  })

  it('never throws even when the insert fails', async () => {
    // actor_role has no CHECK but action is NOT NULL — force a failure via an
    // impossible value and assert the fire-and-forget contract holds.
    await expect(
      writeAudit({
        actorRole: 'manager',
        actorLabel: 'x',
        // @ts-expect-error - deliberately breaking the contract
        action: null,
      }),
    ).resolves.toBeUndefined()
  })

  it('prefix filter does not match mid-string', async () => {
    await writeAudit({
      actorRole: 'admin',
      actorLabel: 'Prefix Test',
      action: `${ns}.other`,
    })

    // Searching for a fragment that only appears mid-action yields nothing.
    const page = await listAudit({
      limit: 10,
      offset: 0,
      actionPrefix: 'other',
    })
    const ours = page.rows.filter((r) => r.action.startsWith(ns))
    expect(ours.length).toBe(0)
  })
})
