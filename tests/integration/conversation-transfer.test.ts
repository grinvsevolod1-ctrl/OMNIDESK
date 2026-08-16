import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Integration test: conversation transfer between managers.
 *
 * The most consequential inbox action — a dialog with a REAL client moves to
 * another person. Verifies the guards in lib/data/conversation-transfer.ts:
 *   1. happy path moves the conversation and writes a transfer record
 *   2. transfer to self is rejected
 *   3. transfer to a blocked manager is rejected
 *   4. transfer by a non-owner is rejected (IDOR guard)
 *   5. two CONCURRENT transfers of the same dialog: exactly one wins
 *
 * Requires DATABASE_URL (real Postgres with migrations). Skipped otherwise.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe.skipIf(!HAS_DB)('conversation transfer', () => {
  let query: typeof import('@/lib/db').query
  let closePool: typeof import('@/lib/db').closePool
  let transferConversation: typeof import('@/lib/data/conversation-transfer').transferConversation

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let ownerId: string
  let targetId: string
  let blockedId: string
  let outsiderId: string
  let channelId: string

  async function makeConversation(): Promise<string> {
    const rows = await query<{ id: string }>(
      `INSERT INTO conversations (channel_id, manager_id, client_name, status)
       VALUES ($1, $2, 'Transfer Test Client', 'active') RETURNING id`,
      [channelId, ownerId],
    )
    return rows[0].id
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('@/lib/db'))
    ;({ transferConversation } = await import(
      '@/lib/data/conversation-transfer'
    ))

    const mk = async (name: string, status: string): Promise<string> => {
      const rows = await query<{ id: string }>(
        `INSERT INTO managers (name, email, password_hash, status)
         VALUES ($1, $2, 'x', $3) RETURNING id`,
        [name, `${name}-${suffix}@test.invalid`, status],
      )
      return rows[0].id
    }

    ownerId = await mk('xfer-owner', 'active')
    targetId = await mk('xfer-target', 'active')
    blockedId = await mk('xfer-blocked', 'blocked')
    outsiderId = await mk('xfer-outsider', 'active')

    const channels = await query<{ id: string }>(
      `INSERT INTO channels (manager_id, type, name, status)
       VALUES ($1, 'livechat', 'xfer-test-channel', 'connected') RETURNING id`,
      [ownerId],
    )
    channelId = channels[0].id
  })

  afterAll(async () => {
    // Manager deletes cascade to channels -> conversations -> transfers.
    for (const id of [ownerId, targetId, blockedId, outsiderId]) {
      if (id) await query(`DELETE FROM managers WHERE id = $1`, [id])
    }
    await closePool()
  })

  it('moves the conversation and records the transfer', async () => {
    const convId = await makeConversation()

    const ok = await transferConversation({
      conversationId: convId,
      fromManagerId: ownerId,
      toManagerId: targetId,
      note: 'integration test',
    })
    expect(ok).toBe(true)

    const [conv] = await query<{ manager_id: string }>(
      `SELECT manager_id FROM conversations WHERE id = $1`,
      [convId],
    )
    expect(conv.manager_id).toBe(targetId)

    const transfers = await query<{ from_manager_id: string; note: string }>(
      `SELECT from_manager_id, note FROM conversation_transfers
        WHERE conversation_id = $1`,
      [convId],
    )
    expect(transfers.length).toBe(1)
    expect(transfers[0].from_manager_id).toBe(ownerId)
  })

  it('rejects transfer to self', async () => {
    const convId = await makeConversation()
    const ok = await transferConversation({
      conversationId: convId,
      fromManagerId: ownerId,
      toManagerId: ownerId,
    })
    expect(ok).toBe(false)
  })

  it('rejects transfer to a blocked manager', async () => {
    const convId = await makeConversation()
    const ok = await transferConversation({
      conversationId: convId,
      fromManagerId: ownerId,
      toManagerId: blockedId,
    })
    expect(ok).toBe(false)
  })

  it('rejects transfer by a manager who does not own the dialog', async () => {
    const convId = await makeConversation()
    const ok = await transferConversation({
      conversationId: convId,
      fromManagerId: outsiderId, // not the owner
      toManagerId: targetId,
    })
    expect(ok).toBe(false)

    const [conv] = await query<{ manager_id: string }>(
      `SELECT manager_id FROM conversations WHERE id = $1`,
      [convId],
    )
    expect(conv.manager_id).toBe(ownerId)
  })

  it('exactly one of two concurrent transfers wins', async () => {
    const convId = await makeConversation()

    // Owner races to hand the same dialog to two different targets at once.
    const results = await Promise.all([
      transferConversation({
        conversationId: convId,
        fromManagerId: ownerId,
        toManagerId: targetId,
      }),
      transferConversation({
        conversationId: convId,
        fromManagerId: ownerId,
        toManagerId: outsiderId,
      }),
    ])

    const wins = results.filter(Boolean).length
    expect(wins).toBe(1)

    // The dialog belongs to exactly one of the two targets, and exactly one
    // transfer record exists.
    const [conv] = await query<{ manager_id: string }>(
      `SELECT manager_id FROM conversations WHERE id = $1`,
      [convId],
    )
    expect([targetId, outsiderId]).toContain(conv.manager_id)

    const transfers = await query<{ id: string }>(
      `SELECT id FROM conversation_transfers WHERE conversation_id = $1`,
      [convId],
    )
    expect(transfers.length).toBe(1)
  })
})
