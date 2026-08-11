/**
 * Lead cards: structured lead data filled from a conversation and optionally
 * transferred to a curator matched by city. Curators maintain a daily status
 * and comment trail on each transferred lead.
 *
 * Integrity rules (migration 114):
 * - Deleting a manager keeps the cards (manager_id -> NULL).
 * - Deleting a comment author keeps the comment with a name snapshot.
 * - Every transfer is recorded in lead_transfers with name snapshots.
 *
 * Распил монолита: типы/конвертеры — lead-cards-core.ts, журнал статусов и
 * передач — lead-history.ts, админская выборка/корзина/inline-редактор —
 * lead-admin.ts, подбор кураторов — lead-curators.ts, дисциплина —
 * lead-discipline.ts. Всё ре-экспортируется отсюда для обратной совместимости.
 */
import { randomUUID } from 'crypto'
import { query, withTransaction } from '../db'
import {
  isLeadStatus,
  type LeadStatus,
  STATUS_COMMENT_MIN_LEN,
} from '../lead-status'
import { mskDayKey } from '../time'
import { normalizeCityName, rememberCity } from './cities'
import {
  CARD_SELECT,
  toComment,
  toDateOnly,
  toLeadCard,
  type CommentRow,
  type LeadCard,
  type LeadCardRow,
} from './lead-cards-core'
import { recordStatusHistory, recordTransfer } from './lead-history'

/* Core types and converters live in lead-cards-core.ts. */
export {
  CARD_SELECT,
  toDateOnly,
  toLeadCard,
  type LeadCard,
  type LeadCardComment,
  type LeadCardRow,
  type LeadTransfer,
} from './lead-cards-core'

/* ------------------------------ Core queries ------------------------------ */

export async function getLeadCardByConversation(
  conversationId: string,
): Promise<LeadCard | null> {
  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.conversation_id = $1
      LIMIT 1`,
    [conversationId],
  )
  return rows[0] ? toLeadCard(rows[0]) : null
}

/**
 * Дедупликация карточек: один и тот же человек может написать на РАЗНЫЕ наши
 * аккаунты — тогда у него несколько диалогов, но карточка лида должна быть
 * одна. Ищем существующую карточку по контактной идентичности диалога:
 *   - telegram-username (карточки или диалога, к которому она привязана);
 *   - телефон (только для telegram/whatsapp, где contact_handle — номер).
 * Возвращаем самую свежую совпавшую карточку или null.
 */
export async function findLeadCardForContact(
  conversationId: string,
): Promise<LeadCard | null> {
  const conv = await query<{
    channel_type: string
    contact_handle: string
    contact_username: string | null
  }>(
    `SELECT channel_type, contact_handle, contact_username
       FROM conversations WHERE id = $1 LIMIT 1`,
    [conversationId],
  )
  if (!conv[0]) return null

  const tg = (conv[0].contact_username ?? '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
  // Телефонная идентичность — только для каналов, где handle это номер, и
  // только при правдоподобной длине (иначе visitor-id лайвчата даст ложное
  // совпадение по цифрам).
  const rawDigits = conv[0].contact_handle.replace(/\D/g, '')
  const phone =
    (conv[0].channel_type === 'telegram' ||
      conv[0].channel_type === 'whatsapp') &&
    rawDigits.length >= 10 &&
    rawDigits.length <= 15
      ? rawDigits
      : ''
  if (!tg && !phone) return null

  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
       LEFT JOIN conversations oc ON oc.id = lc.conversation_id
      WHERE (lc.conversation_id IS NULL OR lc.conversation_id <> $1)
        AND (
          ($2 <> '' AND (
            lower(regexp_replace(lc.telegram_username, '^@', '')) = $2
            OR lower(regexp_replace(coalesce(oc.contact_username, ''), '^@', '')) = $2
          ))
          OR ($3 <> '' AND (
            regexp_replace(lc.phone, '\\D', '', 'g') = $3
            OR (oc.channel_type IN ('telegram', 'whatsapp')
                AND regexp_replace(oc.contact_handle, '\\D', '', 'g') = $3)
          ))
        )
      ORDER BY lc.updated_at DESC
      LIMIT 1`,
    [conversationId, tg, phone],
  )
  return rows[0] ? toLeadCard(rows[0]) : null
}

export async function getLeadCardById(id: string): Promise<LeadCard | null> {
  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.id = $1
      LIMIT 1`,
    [id],
  )
  return rows[0] ? toLeadCard(rows[0]) : null
}

export async function listLeadCardsForCurator(
  curatorId: string,
): Promise<LeadCard[]> {
  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.curator_id = $1
        AND lc.transferred_at IS NOT NULL
        AND lc.archived_at IS NULL
      ORDER BY lc.transferred_at DESC`,
    [curatorId],
  )
  return rows.map(toLeadCard)
}

/** Archived leads of a curator, newest archive first (migration 117). */
export async function listArchivedLeadsForCurator(
  curatorId: string,
  limit = 200,
): Promise<LeadCard[]> {
  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.curator_id = $1
        AND lc.transferred_at IS NOT NULL
        AND lc.archived_at IS NOT NULL
      ORDER BY lc.archived_at DESC
      LIMIT $2`,
    [curatorId, Math.max(1, Math.min(500, limit))],
  )
  return rows.map(toLeadCard)
}

/**
 * Archive a final lead (refused/left) or unarchive it back to the active
 * workspace. Archiving requires the lead to be in a final status — active
 * leads stay under the daily gate.
 */
export async function setLeadArchived(input: {
  leadCardId: string
  curatorId: string
  archived: boolean
}): Promise<LeadCard> {
  const rows = await query<{ id: string }>(
    input.archived
      ? `UPDATE lead_cards
            SET archived_at = now(), updated_at = now()
          WHERE id = $1 AND curator_id = $2
            AND status IN ('refused', 'left')
            AND archived_at IS NULL
          RETURNING id`
      : `UPDATE lead_cards
            SET archived_at = NULL, updated_at = now()
          WHERE id = $1 AND curator_id = $2
            AND archived_at IS NOT NULL
          RETURNING id`,
    [input.leadCardId, input.curatorId],
  )
  if (!rows[0]) {
    throw new Error(
      input.archived
        ? 'В архив можно отправить только лид с финальным статусом («Отказался» или «Кинул»).'
        : 'Лид не найден в архиве.',
    )
  }
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

/* ------------------------------- Mutations -------------------------------- */

export interface UpsertLeadCardInput {
  conversationId: string
  managerId: string
  fullName: string
  phone: string
  telegramUsername: string
  city: string
  address: string
  vacancy: string
  /** When set, the card is transferred to this curator. */
  curatorId?: string | null
  /** True when the caller is an admin (may reassign an already-assigned lead). */
  isAdmin?: boolean
}

export interface UpsertLeadCardResult {
  card: LeadCard
  /** True when the curator changed in this call (fresh transfer happened). */
  transferred: boolean
  /** Non-blocking duplicate warning, if any. */
  duplicateWarning: string | null
}

/**
 * Non-blocking duplicate probe: does another card share this phone or
 * telegram username? Returns a human warning or null.
 */
export async function findDuplicateLeadWarning(input: {
  conversationId: string
  phone: string
  telegramUsername: string
}): Promise<string | null> {
  const phone = input.phone.replace(/\D/g, '')
  const tg = input.telegramUsername.trim().replace(/^@/, '').toLowerCase()
  if (!phone && !tg) return null
  const rows = await query<{
    full_name: string
    curator_name: string | null
  }>(
    `SELECT lc.full_name, c.name AS curator_name
       FROM lead_cards lc
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE ($1 IS DISTINCT FROM lc.conversation_id OR lc.conversation_id IS NULL)
        AND (
          ($2 <> '' AND regexp_replace(lc.phone, '\\D', '', 'g') = $2)
          OR ($3 <> '' AND lower(regexp_replace(lc.telegram_username, '^@', '')) = $3)
        )
      LIMIT 1`,
    [input.conversationId, phone, tg],
  )
  const dup = rows[0]
  if (!dup) return null
  const who = dup.full_name || 'без имени'
  return dup.curator_name
    ? `Возможный дубль: карточка «${who}» уже существует и закреплена за менеджером по кадрам ${dup.curator_name}.`
    : `Возможный дубль: карточка «${who}» с теми же контактами уже существует.`
}

export async function upsertLeadCard(
  input: UpsertLeadCardInput,
): Promise<UpsertLeadCardResult> {
  const fullName = input.fullName.trim()
  const phone = input.phone.trim()
  const telegramUsername = input.telegramUsername.trim().replace(/^@/, '')
  // Canonical spelling from the city dictionary («москва» -> «Москва»).
  const city = normalizeCityName(input.city)
    ? await rememberCity(input.city).catch(() => normalizeCityName(input.city))
    : ''
  const address = input.address.trim()
  const vacancy = input.vacancy.trim()
  const curatorId = input.curatorId?.trim() || null

  if (curatorId) {
    const ok = await query<{ id: string }>(
      `SELECT id FROM managers
        WHERE id = $1 AND role = 'curator' AND status = 'active'
        LIMIT 1`,
      [curatorId],
    )
    if (!ok[0]) throw new Error('Curator not found or inactive')
  }

  let existing = await query<{
    id: string
    curator_id: string | null
  }>(
    `SELECT id, curator_id FROM lead_cards WHERE conversation_id = $1 LIMIT 1`,
    [input.conversationId],
  )

  // Дедупликация: если у ЭТОГО диалога карточки нет, но тот же контакт уже
  // имеет карточку через другой диалог (написал на другой наш аккаунт) —
  // обновляем её, а не создаём дубль.
  if (!existing[0]) {
    const contactMatch = await findLeadCardForContact(
      input.conversationId,
    ).catch(() => null)
    if (contactMatch) {
      existing = [
        { id: contactMatch.id, curator_id: contactMatch.curatorId },
      ]
    }
  }

  const duplicateWarning = await findDuplicateLeadWarning({
    conversationId: input.conversationId,
    phone,
    telegramUsername,
  }).catch(() => null)

  if (existing[0]) {
    const prevCuratorId = existing[0].curator_id
    const isReassign =
      curatorId !== null && prevCuratorId !== null && curatorId !== prevCuratorId

    // A manager must not silently hijack a lead already assigned to another
    // curator — reassignment goes through the admin (with a status reset).
    if (isReassign && !input.isAdmin) {
      throw new Error(
        'Лид уже закреплён за другим менеджером по кадрам. Переназначение выполняет администратор.',
      )
    }

    const isFreshTransfer =
      curatorId !== null && curatorId !== prevCuratorId

    await query(
      `UPDATE lead_cards
          SET full_name = $2,
              phone = $3,
              telegram_username = $4,
              city = $5,
              address = $6,
              vacancy = $7,
              manager_id = $8,
              curator_id = COALESCE($9, curator_id),
              transferred_at = CASE
                WHEN $10::boolean THEN now()
                ELSE transferred_at
              END,
              -- Fresh transfer: the new curator must confirm status today.
              status = CASE WHEN $10::boolean THEN NULL ELSE status END,
              previous_status = CASE
                WHEN $10::boolean THEN COALESCE(status, previous_status)
                ELSE previous_status
              END,
              status_confirmed_at = CASE
                WHEN $10::boolean THEN NULL ELSE status_confirmed_at
              END,
              status_confirmed_date = CASE
                WHEN $10::boolean THEN NULL ELSE status_confirmed_date
              END,
              updated_at = now()
        WHERE id = $1`,
      [
        existing[0].id,
        fullName,
        phone,
        telegramUsername,
        city,
        address,
        vacancy,
        input.managerId,
        curatorId,
        isFreshTransfer,
      ],
    )

    if (isFreshTransfer && curatorId) {
      await recordTransfer({
        leadCardId: existing[0].id,
        fromCuratorId: prevCuratorId,
        toCuratorId: curatorId,
        initiatedById: input.isAdmin ? null : input.managerId,
        initiatedByRole: input.isAdmin ? 'admin' : 'manager',
      })
      await recordStatusHistory({
        leadCardId: existing[0].id,
        curatorId,
        status: null,
        reason: 'transfer_reset',
      })
    }

    const card = await getLeadCardById(existing[0].id)
    if (!card) throw new Error('Lead card update failed')
    return { card, transferred: isFreshTransfer, duplicateWarning }
  }

  const id = randomUUID()
  await query(
    `INSERT INTO lead_cards (
       id, conversation_id, manager_id, curator_id,
       full_name, phone, telegram_username, city, address, vacancy,
       transferred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               CASE WHEN $4::uuid IS NOT NULL THEN now() ELSE NULL END)`,
    [
      id,
      input.conversationId,
      input.managerId,
      curatorId,
      fullName,
      phone,
      telegramUsername,
      city,
      address,
      vacancy,
    ],
  )

  if (curatorId) {
    await recordTransfer({
      leadCardId: id,
      fromCuratorId: null,
      toCuratorId: curatorId,
      initiatedById: input.isAdmin ? null : input.managerId,
      initiatedByRole: input.isAdmin ? 'admin' : 'manager',
    })
  }

  const card = await getLeadCardById(id)
  if (!card) throw new Error('Lead card create failed')
  return { card, transferred: Boolean(curatorId), duplicateWarning }
}

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
      [
        randomUUID(),
        input.leadCardId,
        input.authorName,
        comment,
        input.status,
      ],
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
  authorId: string
  body: string
}): Promise<import('./lead-cards-core').LeadCardComment> {
  const body = input.body.trim()
  if (body.length < 1) throw new Error('Пустой комментарий')

  const id = randomUUID()
  const rows = await query<CommentRow>(
    `INSERT INTO lead_card_comments (id, lead_card_id, author_id, author_name, body, status)
     VALUES ($1, $2, $3, (SELECT name FROM managers WHERE id = $3), $4, NULL)
     RETURNING id, lead_card_id, author_id, author_name, body, status, created_at`,
    [id, input.leadCardId, input.authorId, body],
  )
  return toComment(rows[0])
}

export async function listLeadComments(
  leadCardId: string,
): Promise<import('./lead-cards-core').LeadCardComment[]> {
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

/*
 * Curator pickers moved to lead-curators.ts; re-exported for compatibility.
 */
export {
  findCuratorsByCity,
  listActiveCurators,
  type CuratorWithLoad,
} from './lead-curators'

/*
 * Status/transfer history moved to lead-history.ts.
 */
export {
  listLeadStatusHistory,
  listLeadTransfers,
  type LeadStatusHistoryEntry,
} from './lead-history'

/*
 * Admin overview, trash (soft delete) and inline editing moved to lead-admin.ts.
 */
export {
  isInlineLeadField,
  listAllTransferredLeads,
  listDeletedLeads,
  parseLeadSearch,
  purgeDeletedLeads,
  restoreLeadCard,
  softDeleteLeadCard,
  updateLeadCardField,
  type AllLeadsFilter,
  type DeletedLead,
  type InlineLeadField,
} from './lead-admin'

/*
 * Discipline / daily-gate queries moved to lead-discipline.ts.
 * Re-exported here so existing call sites keep working.
 */
export {
  countLeadsNeedingStatus,
  getCuratorDiscipline,
  getCuratorDisciplineHistory,
  listCuratorsWithOverdueStatuses,
  type CuratorDiscipline,
  type CuratorDisciplineHistory,
} from './lead-discipline'
