/**
 * Lead cards: post-transfer lifecycle — admin transfer with status reset,
 * curator/admin status confirmation, and the comment trail.
 */
import { randomUUID } from 'crypto'
import { query, withTransaction } from '../db'
import {
  isLeadStatus,
  type LeadStatus,
  STATUS_COMMENT_MIN_LEN,
} from '../lead-status'
import { mskDayKey } from '../time'
import {
  toComment,
  toDateOnly,
  type CommentRow,
  type LeadCard,
  type LeadCardComment,
} from './lead-cards-core'
import { recordStatusHistory, recordTransfer } from './lead-history'
import { getLeadCardById } from './lead-cards-queries'

/**
 * Admin: (re)assign a lead to another active curator with a status reset.
 *
 * Runs as ONE transaction with a row lock on the lead: the UPDATE, the
 * transfer record and the history entry either all land or none do. Without
 * this, two admins transferring the same lead concurrently could both read
 * the same `fromCuratorId` and write contradictory history, and a crash
 * mid-way left a re-assigned lead with no trace in lead_transfers.
 */
export async function transferLeadToCurator(
  leadCardId: string,
  newCuratorId: string,
): Promise<LeadCard> {
  const id = await withTransaction(async (db) => {
    const ok = await db.query<{ id: string }>(
      `SELECT id FROM managers
        WHERE id = $1 AND role = 'curator' AND status = 'active'
        LIMIT 1`,
      [newCuratorId],
    )
    if (!ok[0]) throw new Error('Curator not found or inactive')

    // Lock the row so a concurrent transfer serializes behind us and reads
    // the curator we are about to set, not the stale one.
    const prev = await db.query<{ curator_id: string | null }>(
      `SELECT curator_id FROM lead_cards WHERE id = $1 FOR UPDATE`,
      [leadCardId],
    )
    if (!prev[0]) throw new Error('Лид не найден')

    await db.query(
      `UPDATE lead_cards
          SET curator_id = $2,
              transferred_at = now(),
              -- New curator must confirm status for today.
              status = NULL,
              previous_status = COALESCE(status, previous_status),
              status_confirmed_at = NULL,
              status_confirmed_date = NULL,
              updated_at = now()
        WHERE id = $1`,
      [leadCardId, newCuratorId],
    )

    await recordTransfer(
      {
        leadCardId,
        fromCuratorId: prev[0].curator_id,
        toCuratorId: newCuratorId,
        initiatedById: null,
        initiatedByRole: 'admin',
      },
      db,
    )
    await recordStatusHistory(
      {
        leadCardId,
        curatorId: newCuratorId,
        status: null,
        reason: 'transfer_reset',
      },
      db,
    )
    return leadCardId
  })

  const card = await getLeadCardById(id)
  if (!card) throw new Error('Lead transfer failed')
  return card
}

/**
 * Curator confirms today's status for a lead. Always requires a comment
 * (>= STATUS_COMMENT_MIN_LEN). Moves the previous confirmed status into
 * previous_status when the day changes.
 */
export async function updateLeadStatus(input: {
  leadCardId: string
  curatorId: string
  status: LeadStatus
  comment: string
}): Promise<LeadCard> {
  const comment = input.comment.trim()
  if (comment.length < STATUS_COMMENT_MIN_LEN) {
    throw new Error(
      `Комментарий должен быть не короче ${STATUS_COMMENT_MIN_LEN} символов.`,
    )
  }
  if (!isLeadStatus(input.status)) {
    throw new Error('Некорректный статус')
  }

  // One transaction with a row lock: the status write, the mandatory comment
  // and the history entry land atomically. Curator discipline is computed
  // from history+comments, so a partial write (status without comment) used
  // to silently corrupt the discipline picture if the process died mid-way.
  await withTransaction(async (db) => {
    const existing = await db.query<{
      id: string
      curator_id: string | null
      status: string | null
      status_confirmed_date: string | Date | null
    }>(
      `SELECT id, curator_id, status, status_confirmed_date
         FROM lead_cards WHERE id = $1 FOR UPDATE`,
      [input.leadCardId],
    )
    const row = existing[0]
    if (!row) throw new Error('Лид не найден')
    if (row.curator_id !== input.curatorId) {
      throw new Error('Этот лид принадлежит другому менеджеру по кадрам')
    }

    const today = mskDayKey(new Date())
    const prevDate = toDateOnly(row.status_confirmed_date)
    const carryPrevious =
      isLeadStatus(row.status) && prevDate && prevDate !== today
        ? row.status
        : null

    await db.query(
      `UPDATE lead_cards
          SET previous_status = COALESCE($3, previous_status),
              status = $2,
              status_confirmed_at = now(),
              status_confirmed_date = $4::date,
              updated_at = now()
        WHERE id = $1`,
      [input.leadCardId, input.status, carryPrevious, today],
    )

    await db.query(
      `INSERT INTO lead_card_comments (id, lead_card_id, author_id, author_name, body, status)
       VALUES ($1, $2, $3, (SELECT name FROM managers WHERE id = $3), $4, $5)`,
      [randomUUID(), input.leadCardId, input.curatorId, comment, input.status],
    )

    await recordStatusHistory(
      {
        leadCardId: input.leadCardId,
        curatorId: input.curatorId,
        status: input.status,
        reason: 'confirm',
      },
      db,
    )
  })

  const card = await getLeadCardById(input.leadCardId)
  if (!card) throw new Error('Status update failed')
  return card
}

/**
 * Админ: смена статуса + комментарий из строки таблицы. Как updateLeadStatus,
 * но без проверки владения (админ может править любой лид). Автор комментария
 * фиксируется снапшотом — админ живёт вне таблицы managers.
 */
export async function adminSetLeadStatus(input: {
  leadCardId: string
  status: LeadStatus
  comment: string
  authorName: string
}): Promise<void> {
  const comment = input.comment.trim()
  if (comment.length < STATUS_COMMENT_MIN_LEN) {
    throw new Error(
      `Комментарий должен быть не короче ${STATUS_COMMENT_MIN_LEN} символов.`,
    )
  }
  if (!isLeadStatus(input.status)) {
    throw new Error('Некорректный статус')
  }

  await withTransaction(async (db) => {
    const existing = await db.query<{
      id: string
      status: string | null
      status_confirmed_date: string | Date | null
    }>(
      `SELECT id, status, status_confirmed_date
         FROM lead_cards WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [input.leadCardId],
    )
    const row = existing[0]
    if (!row) throw new Error('Лид не найден')

    const today = mskDayKey(new Date())
    const prevDate = toDateOnly(row.status_confirmed_date)
    const carryPrevious =
      isLeadStatus(row.status) && prevDate && prevDate !== today
        ? row.status
        : null

    await db.query(
      `UPDATE lead_cards
          SET previous_status = COALESCE($3, previous_status),
              status = $2,
              status_confirmed_at = now(),
              status_confirmed_date = $4::date,
              updated_at = now()
        WHERE id = $1`,
      [input.leadCardId, input.status, carryPrevious, today],
    )

    await db.query(
      `INSERT INTO lead_card_comments (id, lead_card_id, author_id, author_name, body, status)
       VALUES ($1, $2, NULL, $3, $4, $5)`,
      [randomUUID(), input.leadCardId, input.authorName, comment, input.status],
    )

    await db.query(
      `INSERT INTO lead_status_history
         (lead_card_id, curator_id, curator_name, status, reason)
       VALUES ($1, NULL, $2, $3, 'confirm')`,
      [input.leadCardId, input.authorName, input.status],
    )
  })
}

/** Free-form comment without changing status (optional helper). */
export async function addLeadComment(input: {
  leadCardId: string
  /** null — админ: он живёт вне таблицы managers (FK хранит NULL). */
  authorId: string | null
  /** Снапшот имени автора; для authorId=null (админ) обязателен. */
  authorName?: string | null
  body: string
}): Promise<LeadCardComment> {
  const body = input.body.trim()
  if (body.length < 1) throw new Error('Пустой комментарий')

  const id = randomUUID()
  const rows = await query<CommentRow>(
    `INSERT INTO lead_card_comments (id, lead_card_id, author_id, author_name, body, status)
     VALUES ($1, $2, $3, COALESCE($5, (SELECT name FROM managers WHERE id = $3)), $4, NULL)
     RETURNING id, lead_card_id, author_id, author_name, body, status, created_at`,
    [id, input.leadCardId, input.authorId, body, input.authorName ?? null],
  )
  return toComment(rows[0])
}

export async function listLeadComments(
  leadCardId: string,
): Promise<LeadCardComment[]> {
  const rows = await query<CommentRow>(
    `SELECT c.id, c.lead_card_id, c.author_id, c.body, c.status, c.created_at,
            COALESCE(m.name, c.author_name) AS author_name
       FROM lead_card_comments c
       LEFT JOIN managers m ON m.id = c.author_id
      WHERE c.lead_card_id = $1
      ORDER BY c.created_at DESC`,
    [leadCardId],
  )
  return rows.map(toComment)
}
