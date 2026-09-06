import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Integration test: buyer data isolation (migration 145).
 *
 * A media buyer's entire section is scoped by `buyer_id = session.sub`. This
 * verifies the DB-level guarantees that back that scope:
 *   1. a buyer sees ONLY their own traffic sources
 *   2. a buyer sees ONLY lead cards belonging to their own sources
 *   3. one buyer can never see another buyer's sources or leads (isolation)
 *   4. soft-deleted lead cards are excluded
 *
 * These are the invariants the buyer-role bug fixed this session depended on:
 * once the role maps correctly, the queries must also be watertight.
 *
 * Requires DATABASE_URL (real Postgres with migrations). Skipped otherwise.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe.skipIf(!HAS_DB)('buyer data scoping', () => {
  let query: typeof import('@/lib/db').query
  let closePool: typeof import('@/lib/db').closePool
  let listTrafficSourcesForBuyer: typeof import('@/lib/data/traffic-sources').listTrafficSourcesForBuyer
  let listLeadCardsForBuyer: typeof import('@/lib/data/traffic-sources').listLeadCardsForBuyer

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let buyerA: string
  let buyerB: string
  let sourceA: string
  let sourceB: string
  let leadA: string
  let leadB: string
  let leadADeleted: string

  beforeAll(async () => {
    ;({ query, closePool } = await import('@/lib/db'))
    ;({ listTrafficSourcesForBuyer, listLeadCardsForBuyer } = await import(
      '@/lib/data/traffic-sources'
    ))

    const mkBuyer = async (name: string): Promise<string> => {
      const rows = await query<{ id: string }>(
        `INSERT INTO managers (name, email, password_hash, status, role)
         VALUES ($1, $2, 'x', 'active', 'buyer') RETURNING id`,
        [name, `${name}-${suffix}@test.invalid`],
      )
      return rows[0].id
    }

    const { randomUUID } = await import('node:crypto')
    const mkSource = async (
      name: string,
      buyerId: string,
    ): Promise<string> => {
      // traffic_sources.id has no DB default; the app generates it (see
      // createTrafficSource), so the fixture must too.
      const id = randomUUID()
      await query(
        `INSERT INTO traffic_sources (id, name, buyer_id) VALUES ($1, $2, $3)`,
        [id, `${name}-${suffix}`, buyerId],
      )
      return id
    }

    const mkLead = async (
      sourceId: string,
      deleted: boolean,
    ): Promise<string> => {
      const rows = await query<{ id: string }>(
        `INSERT INTO lead_cards (traffic_source_id, status, deleted_at)
         VALUES ($1, 'new', $2) RETURNING id`,
        [sourceId, deleted ? new Date() : null],
      )
      return rows[0].id
    }

    buyerA = await mkBuyer('buyer-a')
    buyerB = await mkBuyer('buyer-b')
    sourceA = await mkSource('src-a', buyerA)
    sourceB = await mkSource('src-b', buyerB)
    leadA = await mkLead(sourceA, false)
    leadADeleted = await mkLead(sourceA, true)
    leadB = await mkLead(sourceB, false)
  })

  afterAll(async () => {
    for (const id of [leadA, leadADeleted, leadB]) {
      if (id) await query(`DELETE FROM lead_cards WHERE id = $1`, [id])
    }
    for (const id of [sourceA, sourceB]) {
      if (id) await query(`DELETE FROM traffic_sources WHERE id = $1`, [id])
    }
    for (const id of [buyerA, buyerB]) {
      if (id) await query(`DELETE FROM managers WHERE id = $1`, [id])
    }
    await closePool()
  })

  it('buyer sees only their own traffic sources', async () => {
    const sourcesA = await listTrafficSourcesForBuyer(buyerA)
    const idsA = sourcesA.map((s) => s.id)
    expect(idsA).toContain(sourceA)
    expect(idsA).not.toContain(sourceB)

    const sourcesB = await listTrafficSourcesForBuyer(buyerB)
    const idsB = sourcesB.map((s) => s.id)
    expect(idsB).toContain(sourceB)
    expect(idsB).not.toContain(sourceA)
  })

  it('buyer sees only lead cards of their own sources', async () => {
    const leadsA = await listLeadCardsForBuyer(buyerA)
    const idsA = leadsA.map((l) => l.id)
    expect(idsA).toContain(leadA)
    expect(idsA).not.toContain(leadB)
  })

  it('excludes soft-deleted lead cards', async () => {
    const leadsA = await listLeadCardsForBuyer(buyerA)
    expect(leadsA.map((l) => l.id)).not.toContain(leadADeleted)
  })

  it('a buyer with no sources sees nothing (empty, not error)', async () => {
    const orphan = await query<{ id: string }>(
      `INSERT INTO managers (name, email, password_hash, status, role)
       VALUES ('buyer-orphan', $1, 'x', 'active', 'buyer') RETURNING id`,
      [`buyer-orphan-${suffix}@test.invalid`],
    )
    const orphanId = orphan[0].id
    try {
      expect(await listTrafficSourcesForBuyer(orphanId)).toEqual([])
      expect(await listLeadCardsForBuyer(orphanId)).toEqual([])
    } finally {
      await query(`DELETE FROM managers WHERE id = $1`, [orphanId])
    }
  })
})
