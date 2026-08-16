import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Integration test: message/media ownership scoping (IDOR protection).
 *
 * getMessageOwner(messageId, managerId) is the authorization primitive behind
 * /api/media/[id] and /api/messages/[id]/edits: it must return the channel
 * ONLY when the message belongs to a conversation assigned to that manager.
 * A manager holding a valid message id of ANOTHER manager must get null —
 * that is exactly the IDOR an attacker would try.
 *
 * Requires DATABASE_URL; skipped otherwise.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe.skipIf(!HAS_DB)('message ownership scoping (IDOR)', () => {
  let query: typeof import('@/lib/db').query
  let closePool: typeof import('@/lib/db').closePool
  let getMessageOwner: typeof import('@/lib/data/message-admin').getMessageOwner
  let getMessageOwnerAdmin: typeof import('@/lib/data/message-admin').getMessageOwnerAdmin

  let ownerId: string
  let strangerId: string
  let channelId: string
  let messageId: string

  beforeAll(async () => {
    ;({ query, closePool } = await import('@/lib/db'))
    ;({ getMessageOwner, getMessageOwnerAdmin } = await import(
      '@/lib/data/message-admin'
    ))

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const managers = await query<{ id: string }>(
      `INSERT INTO managers (name, email, password_hash)
       VALUES ('Owner', $1, 'x'), ('Stranger', $2, 'x')
       RETURNING id`,
      [`own-${stamp}@test.invalid`, `str-${stamp}@test.invalid`],
    )
    ownerId = managers[0].id
    strangerId = managers[1].id

    const channels = await query<{ id: string }>(
      `INSERT INTO channels (manager_id, type, name, status)
       VALUES ($1, 'livechat', 'idor-test-channel', 'connected') RETURNING id`,
      [ownerId],
    )
    channelId = channels[0].id

    const conversations = await query<{ id: string }>(
      `INSERT INTO conversations
         (channel_id, manager_id, channel_type, contact_name, contact_handle)
       VALUES ($1, $2, 'livechat', 'IDOR Visitor', $3) RETURNING id`,
      [channelId, ownerId, `idor-${stamp}`],
    )
    const messages = await query<{ id: string }>(
      `INSERT INTO messages (conversation_id, direction, body)
       VALUES ($1, 'in', 'secret payload') RETURNING id`,
      [conversations[0].id],
    )
    messageId = messages[0].id
  })

  afterAll(async () => {
    if (ownerId) await query(`DELETE FROM managers WHERE id = ANY($1)`, [[ownerId, strangerId]])
    await closePool()
  })

  it('grants the assigned manager access to their message', async () => {
    const owner = await getMessageOwner(messageId, ownerId)
    expect(owner).not.toBeNull()
    expect(owner!.channelId).toBe(channelId)
    expect(owner!.channelType).toBe('livechat')
  })

  it('denies another manager holding a valid message id (IDOR)', async () => {
    const owner = await getMessageOwner(messageId, strangerId)
    expect(owner).toBeNull()
  })

  it('denies a syntactically valid but nonexistent message id', async () => {
    const owner = await getMessageOwner(
      '00000000-0000-4000-8000-000000000000',
      ownerId,
    )
    expect(owner).toBeNull()
  })

  it('admin-wide variant resolves any message regardless of manager', async () => {
    const owner = await getMessageOwnerAdmin(messageId)
    expect(owner).not.toBeNull()
    expect(owner!.channelId).toBe(channelId)
  })
})
