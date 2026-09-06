import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Integration test: the AI-silencing gate (migration 151).
 *
 * Invariant: the AI manager leads a dialog only while it is enrolled, not
 * paused, the master switch is on, AND `conversations.curator_id IS NULL`.
 * The moment a lead is handed to a curator, the AI must go silent regardless
 * of enrollment — the curator now handles the dialog by hand.
 *
 * `isConversationAiLed` (panel) and worker/src/repo-ai-context.ts must share
 * this exact formula; this test locks the panel side against a regression that
 * would let the AI keep replying over a curator.
 *
 * Requires DATABASE_URL. Skipped otherwise.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe.skipIf(!HAS_DB)('AI-silencing gate on curator handoff', () => {
  let query: typeof import('@/lib/db').query
  let closePool: typeof import('@/lib/db').closePool
  let isConversationAiLed: typeof import('@/lib/data/ai-assist-enrollment').isConversationAiLed
  let linkConversationToCurator: typeof import('@/lib/data/curator-conversations').linkConversationToCurator
  let unlinkConversationFromCurator: typeof import('@/lib/data/curator-conversations').unlinkConversationFromCurator

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let managerId: string
  let curatorId: string
  let channelId: string
  let convId: string
  let priorEnabled = false

  beforeAll(async () => {
    ;({ query, closePool } = await import('@/lib/db'))
    ;({ isConversationAiLed } = await import('@/lib/data/ai-assist-enrollment'))
    ;({ linkConversationToCurator, unlinkConversationFromCurator } =
      await import('@/lib/data/curator-conversations'))

    const mgr = await query<{ id: string }>(
      `INSERT INTO managers (name, email, password_hash, status, role)
       VALUES ('mgr-ai', $1, 'x', 'active', 'manager') RETURNING id`,
      [`mgr-ai-${suffix}@test.invalid`],
    )
    managerId = mgr[0].id
    // curators require a non-empty city (managers_city_role_check).
    const cur = await query<{ id: string }>(
      `INSERT INTO managers (name, email, password_hash, status, role, city)
       VALUES ('cur-ai', $1, 'x', 'active', 'curator', 'Москва') RETURNING id`,
      [`cur-ai-${suffix}@test.invalid`],
    )
    curatorId = cur[0].id

    // non-telegram_personal channels require a manager_id
    // (channels_manager_required_check).
    const ch = await query<{ id: string }>(
      `INSERT INTO channels (type, name, status, manager_id)
       VALUES ('livechat', $1, 'connected', $2) RETURNING id`,
      [`ch-ai-${suffix}`, managerId],
    )
    channelId = ch[0].id

    // Dialog is auto-enrolled (ai_enrolled defaults true), not paused.
    const conv = await query<{ id: string }>(
      `INSERT INTO conversations (channel_id, manager_id, channel_type, ai_enrolled, ai_paused)
       VALUES ($1, $2, 'livechat', true, false) RETURNING id`,
      [channelId, managerId],
    )
    convId = conv[0].id

    // Turn the master AI switch ON for the duration of the test, remembering
    // the prior value so we can restore it (single global settings row).
    const settings = await query<{ enabled: boolean }>(
      `SELECT enabled FROM ai_assist_settings WHERE id = true`,
    )
    priorEnabled = settings[0]?.enabled ?? false
    await query(`UPDATE ai_assist_settings SET enabled = true WHERE id = true`)
  })

  afterAll(async () => {
    await query(`UPDATE ai_assist_settings SET enabled = $1 WHERE id = true`, [
      priorEnabled,
    ])
    if (convId) await query(`DELETE FROM conversations WHERE id = $1`, [convId])
    if (channelId) await query(`DELETE FROM channels WHERE id = $1`, [channelId])
    for (const id of [managerId, curatorId]) {
      if (id) await query(`DELETE FROM managers WHERE id = $1`, [id])
    }
    await closePool()
  })

  it('AI leads an enrolled, unpaused dialog while master switch is on', async () => {
    expect(await isConversationAiLed(convId)).toBe(true)
  })

  it('AI goes silent the moment the lead is handed to a curator', async () => {
    await linkConversationToCurator(convId, curatorId)
    expect(await isConversationAiLed(convId)).toBe(false)
  })

  it('handoff also stamps curator_id, transferred status and pauses AI', async () => {
    const rows = await query<{
      curator_id: string | null
      status: string | null
      ai_paused: boolean
    }>(
      `SELECT curator_id, status, ai_paused FROM conversations WHERE id = $1`,
      [convId],
    )
    expect(rows[0].curator_id).toBe(curatorId)
    expect(rows[0].status).toBe('transferred')
    expect(rows[0].ai_paused).toBe(true)
  })

  it('returning the lead clears curator_id but does NOT auto-resume the AI', async () => {
    await unlinkConversationFromCurator(convId)
    const rows = await query<{ curator_id: string | null; ai_paused: boolean }>(
      `SELECT curator_id, ai_paused FROM conversations WHERE id = $1`,
      [convId],
    )
    expect(rows[0].curator_id).toBeNull()
    // AI stays paused after return — resuming is an explicit manager decision.
    expect(rows[0].ai_paused).toBe(true)
    // Still not AI-led because it remains paused.
    expect(await isConversationAiLed(convId)).toBe(false)
  })
})
