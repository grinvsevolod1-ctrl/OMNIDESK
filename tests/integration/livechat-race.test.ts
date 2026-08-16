import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Integration test: the livechat "two parallel first messages" race.
 *
 * Verifies the invariant added in migration 128 + lib/data/livechat.ts:
 * N concurrent recordLivechatInbound calls for the SAME new visitor must
 * produce EXACTLY ONE conversation (with all N messages attached to it).
 *
 * Requires DATABASE_URL (a real Postgres with migrations applied). Skipped
 * otherwise, so `pnpm test:integration` stays green on machines without a DB.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe.skipIf(!HAS_DB)('livechat inbound race (migration 128)', () => {
  let query: typeof import('@/lib/db').query
  let closePool: typeof import('@/lib/db').closePool
  let recordLivechatInbound: typeof import('@/lib/data/livechat').recordLivechatInbound

  let managerId: string
  let channelId: string
  const visitorHandle = `race-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  beforeAll(async () => {
    ;({ query, closePool } = await import('@/lib/db'))
    ;({ recordLivechatInbound } = await import('@/lib/data/livechat'))

    // Fixture: a throwaway manager + livechat channel. Cleanup cascades.
    const managers = await query<{ id: string }>(
      `INSERT INTO managers (name, email, password_hash)
       VALUES ('Race Test', $1, 'x') RETURNING id`,
      [`race-test-${Date.now()}@test.invalid`],
    )
    managerId = managers[0].id
    const channels = await query<{ id: string }>(
      `INSERT INTO channels (manager_id, type, name, status)
       VALUES ($1, 'livechat', 'race-test-channel', 'connected') RETURNING id`,
      [managerId],
    )
    channelId = channels[0].id
  })

  afterAll(async () => {
    if (managerId) {
      // Cascades to channels -> conversations -> messages.
      await query(`DELETE FROM managers WHERE id = $1`, [managerId])
    }
    await closePool()
  })

  it('collapses N parallel first messages into exactly one conversation', async () => {
    const N = 8
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        recordLivechatInbound({
          channelId,
          pool: [managerId],
          fallbackManagerId: managerId,
          contactName: 'Race Visitor',
          contactHandle: visitorHandle,
          body: `parallel message ${i}`,
        }),
      ),
    )

    // Every call must succeed — losers of the insert race are expected to
    // recover via the ON CONFLICT path, not to throw.
    const failed = results.filter((r) => r.status === 'rejected')
    expect(failed).toHaveLength(0)

    const fulfilled = results.filter(
      (r) => r.status === 'fulfilled',
    ) as PromiseFulfilledResult<{ conversationId: string }>[]

    // All N calls must agree on ONE conversation id.
    const conversationIds = new Set(fulfilled.map((r) => r.value.conversationId))
    expect(conversationIds.size).toBe(1)

    // The DB must contain exactly one conversation for this visitor...
    const convRows = await query<{ id: string }>(
      `SELECT id FROM conversations
        WHERE channel_id = $1 AND contact_handle = $2 AND channel_type = 'livechat'`,
      [channelId, visitorHandle],
    )
    expect(convRows).toHaveLength(1)

    // ...holding every one of the N messages (none dropped by the race).
    const msgRows = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1`,
      [convRows[0].id],
    )
    expect(Number(msgRows[0].count)).toBe(N)
  })

  it('routes a repeat visitor to the existing conversation (sticky binding)', async () => {
    const before = await query<{ id: string }>(
      `SELECT id FROM conversations
        WHERE channel_id = $1 AND contact_handle = $2`,
      [channelId, visitorHandle],
    )
    expect(before).toHaveLength(1)

    const res = await recordLivechatInbound({
      channelId,
      pool: [managerId],
      fallbackManagerId: managerId,
      contactName: 'Race Visitor',
      contactHandle: visitorHandle,
      body: 'follow-up message',
    })
    expect(res.conversationId).toBe(before[0].id)
  })
})
