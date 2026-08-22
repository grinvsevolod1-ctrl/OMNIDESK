/**
 * Lead cards: archive lifecycle — manual archive/unarchive of final leads and
 * the cron-driven auto-archive sweep (migration 117).
 */
import { randomUUID } from 'crypto'
import { query, withTransaction } from '../db'
import {
  isArchiveLeadStatus,
  isLeadStatus,
  STATUS_COMMENT_MIN_LEN,
  type LeadStatus,
} from '../lead-status'
import { mskDayKey } from '../time'
import { toDateOnly, type LeadCard } from './lead-cards-core'
import { recordStatusHistory } from './lead-history'
import { getLeadCardById } from './lead-cards-queries'

/**
 * Перенос лида в архив с ЛЮБОГО текущего статуса: одной транзакцией
 * выставляется выбранный нерабочий статус («Игнор» / «Отказался» / «Кинул»),
 * сохраняется обязательный комментарий, пишется журнал статусов
 * ('confirm' + 'archived') и лид уходит в архив. Частичная запись
 * невозможна — либо всё, либо ничего.
 *
 * `curatorId = null` — админ: владелец не проверяется, автор комментария
 * фиксируется снапшотом имени (`actorName`).
 */
export async function archiveLeadWithStatus(input: {
  leadCardId: string
  /** null — действие админа (без проверки владельца). */
  curatorId: string | null
  status: LeadStatus
  comment: string
  /** Снапшот имени актора; для curatorId=null (админ) обязателен. */
  actorName?: string | null
}): Promise<LeadCard> {
  const comment = input.comment.trim()
  if (!isArchiveLeadStatus(input.status)) {
    throw new Error(
      'В архив можно отправить только со статусом «Игнор», «Отказался» или «Кинул».',
    )
  }
  if (comment.length < STATUS_COMMENT_MIN_LEN) {
    throw new Error(
      `Комментарий обязателен — минимум ${STATUS_COMMENT_MIN_LEN} символов.`,
    )
  }

  await withTransaction(async (db) => {
    const rows = await db.query<{
      id: string
      curator_id: string | null
      status: string | null
      status_confirmed_date: string | Date | null
      archived_at: string | Date | null
    }>(
      `SELECT id, curator_id, status, status_confirmed_date, archived_at
         FROM lead_cards
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [input.leadCardId],
    )
    const row = rows[0]
    if (!row) throw new Error('Лид не найден')
    if (input.curatorId !== null && row.curator_id !== input.curatorId) {
      throw new Error('Этот лид принадлежит другому менеджеру по кадрам')
    }
    if (row.archived_at) throw new Error('Лид уже в архиве.')

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
              archived_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [input.leadCardId, input.status, carryPrevious, today],
    )

    await db.query(
      `INSERT INTO lead_card_comments (id, lead_card_id, author_id, author_name, body, status)
       VALUES ($1, $2, $3, COALESCE($6, (SELECT name FROM managers WHERE id = $3)), $4, $5)`,
      [
        randomUUID(),
        input.leadCardId,
        input.curatorId,
        comment,
        input.status,
        input.curatorId === null ? (input.actorName ?? 'Администратор') : null,
      ],
    )

    // Двойной след: смена статуса + факт архивации — история карточки
    // показывает и вердикт, и перенос в архив.
    await recordStatusHistory(
      {
        leadCardId: input.leadCardId,
        curatorId: input.curatorId,
        status: input.status,
        reason: 'confirm',
        actorName: input.actorName ?? null,
      },
      db,
    )
    await recordStatusHistory(
      {
        leadCardId: input.leadCardId,
        curatorId: input.curatorId,
        status: null,
        reason: 'archived',
        actorName: input.actorName ?? null,
      },
      db,
    )
  })

  const card = await getLeadCardById(input.leadCardId)
  if (!card) throw new Error('Archive update failed')
  return card
}

/**
 * Archive a final lead (refused/left) or unarchive it back to the active
 * workspace. Archiving requires the lead to be in a final status — active
 * leads stay under the daily gate.
 *
 * `curatorId = null` — админ: владелец не проверяется. Каждое событие пишется
 * в журнал статусов ('archived' / 'unarchived'), чтобы в истории карточки было
 * видно, кто и когда перенёс лид в архив или вернул его.
 */
export async function setLeadArchived(input: {
  leadCardId: string
  /** null — действие админа (без проверки владельца). */
  curatorId: string | null
  archived: boolean
  /** id актора для журнала, если он есть в managers (иначе NULL + снапшот). */
  actorId?: string | null
  /** Снапшот имени актора для журнала (обязателен для админа). */
  actorName?: string | null
}): Promise<LeadCard> {
  const ownerCond = input.curatorId === null ? '' : 'AND curator_id = $2'
  const params =
    input.curatorId === null
      ? [input.leadCardId]
      : [input.leadCardId, input.curatorId]
  const rows = await query<{ id: string }>(
    input.archived
      ? `UPDATE lead_cards
            SET archived_at = now(), updated_at = now()
          WHERE id = $1 ${ownerCond}
            AND status IN ('ignore', 'refused', 'left')
            AND archived_at IS NULL
          RETURNING id`
      : `UPDATE lead_cards
            SET archived_at = NULL, updated_at = now()
          WHERE id = $1 ${ownerCond}
            AND archived_at IS NOT NULL
          RETURNING id`,
    params,
  )
  if (!rows[0]) {
    throw new Error(
      input.archived
        ? 'В архив можно отправить только лид со статусом «Игнор», «Отказался» или «Кинул».'
        : 'Лид не найден в архиве.',
    )
  }
  // Журнал события — best-effort (recordStatusHistory глотает ошибки вне tx).
  await recordStatusHistory({
    leadCardId: rows[0].id,
    curatorId: input.curatorId ?? input.actorId ?? null,
    status: null,
    reason: input.archived ? 'archived' : 'unarchived',
    actorName: input.actorName ?? null,
  })
  const card = await getLeadCardById(rows[0].id)
  if (!card) throw new Error('Archive update failed')
  return card
}

/**
 * Auto-archive final leads whose final status was confirmed more than
 * `afterDays` days ago. Returns the number of leads archived. Called from
 * the curator-status cron; 0 days disables the sweep.
 */
export async function autoArchiveFinalLeads(afterDays: number): Promise<number> {
  if (afterDays <= 0) return 0
  const rows = await query<{ id: string }>(
    `UPDATE lead_cards
        SET archived_at = now(), updated_at = now()
      WHERE archived_at IS NULL
        AND transferred_at IS NOT NULL
        AND status IN ('refused', 'left')
        AND status_confirmed_at IS NOT NULL
        AND status_confirmed_at < now() - make_interval(days => $1)
      RETURNING id`,
    [afterDays],
  )
  return rows.length
}
