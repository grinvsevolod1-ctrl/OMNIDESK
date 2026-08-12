/**
 * Conversation hand-off: manager-to-manager transfer, admin bulk reassignment
 * and transfer-target listing. Split out of conversations.ts (which re-exports
 * this module, so all existing `@/lib/data` imports keep working).
 *
 * Every mutation preserves the same invariants:
 *   - repointing conversations.manager_id fires the realtime trigger, so the
 *     thread pops into the new owner's inbox live;
 *   - reply_dismissed_at is cleared so the new owner sees it as awaiting reply;
 *   - a conversation_transfers audit row records previous → new owner.
 */
import { query, withTransaction } from '../db'

export interface TransferTarget {
  id: string
  name: string
  /** True when the colleague is on lunch (still selectable, shown greyed). */
  onLunch: boolean
}

/**
 * Active managers a conversation can be handed off to, excluding the caller and
 * any blocked accounts. On-lunch managers are still returned (a manual transfer
 * is an explicit choice) but flagged so the UI can de-emphasise them.
 */
export async function listTransferTargets(
  excludeManagerId: string,
): Promise<TransferTarget[]> {
  const rows = await query<{
    id: string
    name: string
    on_lunch: boolean | null
  }>(
    `SELECT id, name, on_lunch
       FROM managers
      WHERE status = 'active' AND id <> $1
      ORDER BY on_lunch ASC, name ASC`,
    [excludeManagerId],
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    onLunch: r.on_lunch ?? false,
  }))
}

/**
 * Hand a conversation off to another manager. Ownership-scoped: only the
 * current owner (fromManagerId) can transfer, which also prevents transferring
 * a thread you can't see. Clears the "reply dismissed" marker so the new owner
 * sees it as awaiting a reply, and records the audit row atomically. Migration
 * 041 is therefore required and is applied by the supported migration runner.
 */
export async function transferConversation(input: {
  conversationId: string
  fromManagerId: string
  toManagerId: string
  note?: string
}): Promise<boolean> {
  // Guard: the target must be an existing active manager (and not the caller).
  const target = await query<{ id: string }>(
    `SELECT id FROM managers WHERE id = $1 AND status = 'active'`,
    [input.toManagerId],
  )
  if (target.length === 0 || input.toManagerId === input.fromManagerId) {
    return false
  }

  return withTransaction(async (db) => {
    const rows = await db.query<{ id: string }>(
      `UPDATE conversations
          SET manager_id = $3, reply_dismissed_at = NULL
        WHERE id = $1 AND manager_id = $2
        RETURNING id`,
      [input.conversationId, input.fromManagerId, input.toManagerId],
    )
    if (rows.length === 0) return false

    await db.query(
      `INSERT INTO conversation_transfers
         (conversation_id, from_manager_id, to_manager_id, note)
       VALUES ($1, $2, $3, $4)`,
      [
        input.conversationId,
        input.fromManagerId,
        input.toManagerId,
        (input.note ?? '').slice(0, 500),
      ],
    )
    return true
  })
}

/**
 * Admin (God-mode) bulk hand-off: move a batch of conversations to another
 * manager, regardless of who currently owns them. Unlike transferConversation
 * this is NOT ownership-scoped — the secret panel operates above any single
 * manager — but it keeps the exact same side effects per moved thread.
 *
 * Threads already owned by the target, or ids that don't exist, are skipped.
 * Returns the number of conversations actually moved.
 */
export async function adminReassignConversations(input: {
  conversationIds: string[]
  toManagerId: string
  note?: string
}): Promise<number> {
  const ids = input.conversationIds.filter(Boolean)
  if (ids.length === 0) return 0

  // Target must be a real, active manager.
  const target = await query<{ id: string }>(
    `SELECT id FROM managers WHERE id = $1 AND status = 'active'`,
    [input.toManagerId],
  )
  if (target.length === 0) return 0

  const note = (input.note ?? '').slice(0, 500)

  return withTransaction(async (db) => {
    // Snapshot previous owners BEFORE the update so the audit trail is accurate,
    // then move only the threads whose owner actually changes.
    const moved = await db.query<{ id: string; from_id: string | null }>(
      `WITH prev AS (
         SELECT id, manager_id AS from_id
           FROM conversations
          WHERE id = ANY($1::uuid[])
       )
       UPDATE conversations c
          SET manager_id = $2, reply_dismissed_at = NULL
         FROM prev
        WHERE c.id = prev.id
          AND c.manager_id IS DISTINCT FROM $2
       RETURNING c.id AS id, prev.from_id AS from_id`,
      [ids, input.toManagerId],
    )
    if (moved.length === 0) return 0

    // One audit row per moved thread (from previous owner → new owner).
    // unnest(a, b) in FROM zips the two arrays positionally and preserves NULL
    // previous owners (an unassigned thread has from_manager_id = NULL).
    await db.query(
      `INSERT INTO conversation_transfers
         (conversation_id, from_manager_id, to_manager_id, note)
       SELECT t.cid, t.fid, $3, $4
         FROM unnest($1::uuid[], $2::uuid[]) AS t(cid, fid)`,
      [
        moved.map((r) => r.id),
        moved.map((r) => r.from_id),
        input.toManagerId,
        note,
      ],
    )
    return moved.length
  })
}

/**
 * Admin-only: every conversation id owned by a manager. Powers «передай ВСЕ
 * диалоги менеджера X менеджеру Y» — the confirm handler resolves the id list
 * server-side at execution time so the client payload stays tiny and fresh.
 */
export async function listConversationIdsForManager(
  managerId: string,
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM conversations WHERE manager_id = $1`,
    [managerId],
  )
  return rows.map((r) => r.id)
}
