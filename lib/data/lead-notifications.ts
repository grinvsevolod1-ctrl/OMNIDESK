/**
 * In-app notifications for curators (migration 149). Currently produced when
 * the admin returns a lead from the archive back to its curator; the curator
 * overview polls unseen notices and shows a modal explaining what came back
 * and why. Kept generic so future notice kinds reuse the same table + modal.
 */
import { query } from '../db'

export type LeadNotificationKind = 'lead_returned_from_archive'

export interface LeadNotification {
  id: string
  leadCardId: string | null
  kind: string
  title: string
  body: string
  leadName: string | null
  createdAt: string
}

interface LeadNotificationRow {
  id: string
  lead_card_id: string | null
  kind: string
  title: string
  body: string
  lead_name: string | null
  created_at: string | Date
}

function toNotification(r: LeadNotificationRow): LeadNotification {
  return {
    id: r.id,
    leadCardId: r.lead_card_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    leadName: r.lead_name,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/** Create a notice for one recipient (curator). Never throws — best effort. */
export async function createLeadNotification(input: {
  recipientId: string
  leadCardId: string | null
  kind: LeadNotificationKind
  title: string
  body: string
  leadName?: string | null
}): Promise<void> {
  await query(
    `INSERT INTO lead_notifications
       (recipient_id, lead_card_id, kind, title, body, lead_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.recipientId,
      input.leadCardId,
      input.kind,
      input.title,
      input.body,
      input.leadName ?? null,
    ],
  )
}

/** Unseen notices for a recipient, newest first (small cap — modal queue). */
export async function listUnseenNotifications(
  recipientId: string,
  limit = 20,
): Promise<LeadNotification[]> {
  const rows = await query<LeadNotificationRow>(
    `SELECT id, lead_card_id, kind, title, body, lead_name, created_at
       FROM lead_notifications
      WHERE recipient_id = $1 AND seen_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
    [recipientId],
  )
  return rows.map(toNotification)
}

/**
 * Mark one notice seen — scoped to the recipient so a curator can never
 * dismiss someone else's notice (IDOR guard). Returns true when it belonged
 * to the recipient and was still unseen.
 */
export async function markNotificationSeen(
  id: string,
  recipientId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE lead_notifications
        SET seen_at = now()
      WHERE id = $1 AND recipient_id = $2 AND seen_at IS NULL
      RETURNING id`,
    [id, recipientId],
  )
  return rows.length > 0
}
