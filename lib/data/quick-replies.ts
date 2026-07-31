/**
 * Manager quick replies (canned responses).
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { query } from '../db'
import type { QuickReply } from '../types'

interface QuickReplyRow {
  id: string
  title: string
  body: string
  sort_order: number
  created_at: string | Date
}

function toQuickReply(r: QuickReplyRow): QuickReply {
  return {
    id: r.id,
    title: r.title ?? '',
    body: r.body,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  }
}

/** All quick replies owned by a manager, in their chosen order. */
export async function listQuickReplies(
  managerId: string,
): Promise<QuickReply[]> {
  const rows = await query<QuickReplyRow>(
    `SELECT id, title, body, sort_order, created_at
       FROM quick_replies
      WHERE manager_id = $1
      ORDER BY sort_order ASC, created_at ASC`,
    [managerId],
  )
  return rows.map(toQuickReply)
}

/** Create a quick reply for a manager. Appends to the end of their list. */
export async function createQuickReply(
  managerId: string,
  title: string,
  body: string,
): Promise<QuickReply | null> {
  const rows = await query<QuickReplyRow>(
    `INSERT INTO quick_replies (manager_id, title, body, sort_order)
     VALUES (
       $1, $2, $3,
       COALESCE((SELECT MAX(sort_order) + 1 FROM quick_replies WHERE manager_id = $1), 0)
     )
     RETURNING id, title, body, sort_order, created_at`,
    [managerId, title, body],
  )
  return rows[0] ? toQuickReply(rows[0]) : null
}

/** Update a quick reply's title/body. Scoped to the owning manager. */
export async function updateQuickReply(
  id: string,
  managerId: string,
  title: string,
  body: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE quick_replies
        SET title = $3, body = $4, updated_at = now()
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [id, managerId, title, body],
  )
  return rows.length > 0
}

/** Delete a quick reply. Scoped to the owning manager. */
export async function deleteQuickReply(
  id: string,
  managerId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM quick_replies
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [id, managerId],
  )
  return rows.length > 0
}

/**
 * Persist a manager's preferred ordering. `orderedIds` is the full list of the
 * manager's quick-reply ids in the desired order; only rows owned by the
 * manager are touched.
 */
export async function reorderQuickReplies(
  managerId: string,
  orderedIds: string[],
): Promise<void> {
  if (orderedIds.length === 0) return
  // One UPDATE keyed by array position keeps this atomic and avoids N queries.
  await query(
    `UPDATE quick_replies AS q
        SET sort_order = pos.idx, updated_at = now()
       FROM unnest($2::uuid[]) WITH ORDINALITY AS pos(id, idx)
      WHERE q.id = pos.id AND q.manager_id = $1`,
    [managerId, orderedIds],
  )
}

