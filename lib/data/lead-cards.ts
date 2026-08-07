/**
 * Lead cards: structured lead data filled from a conversation and optionally
 * transferred to a curator matched by city. Curators maintain a daily status
 * and comment trail on each transferred lead.
 *
 * Integrity rules (migration 114):
 * - Deleting a manager keeps the cards (manager_id -> NULL).
 * - Deleting a comment author keeps the comment with a name snapshot.
 * - Every transfer is recorded in lead_transfers with name snapshots.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
import {
  isLeadStatus,
  type LeadStatus,
  STATUS_COMMENT_MIN_LEN,
} from '../lead-status'
import { mskDayKey } from '../time'
import { normalizeCityName, rememberCity } from './cities'

export interface LeadCard {
  id: string
  conversationId: string | null
  managerId: string | null
  managerName: string | null
  curatorId: string | null
  curatorName: string | null
  curatorCity: string | null
  fullName: string
  phone: string
  telegramUsername: string
  city: string
  address: string
  vacancy: string
  status: LeadStatus | null
  previousStatus: LeadStatus | null
  statusConfirmedAt: string | null
  /** YYYY-MM-DD in MSK when the current status was confirmed. */
  statusConfirmedDate: string | null
  transferredAt: string | null
  /** Set when the lead left the active workspace (final status, migration 117). */
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LeadCardComment {
  id: string
  leadCardId: string
  authorId: string | null
  authorName: string | null
  body: string
  status: LeadStatus | null
  createdAt: string
}

export interface LeadTransfer {
  id: string
  leadCardId: string
  fromCuratorName: string | null
  toCuratorName: string | null
  initiatedByRole: string
  createdAt: string
}

export interface LeadCardRow {
  id: string
  conversation_id: string | null
  manager_id: string | null
  manager_name: string | null
  curator_id: string | null
  curator_name: string | null
  curator_city: string | null
  full_name: string
  phone: string
  telegram_username: string
  city: string
  address: string
  vacancy: string
  status: string | null
  previous_status: string | null
  status_confirmed_at: string | Date | null
  status_confirmed_date: string | Date | null
  transferred_at: string | Date | null
  archived_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

interface CommentRow {
  id: string
  lead_card_id: string
  author_id: string | null
  author_name: string | null
  body: string
  status: string | null
  created_at: string | Date
}

export function toDateOnly(v: string | Date | null | undefined): string | null {
  if (!v) return null
  if (typeof v === 'string') {
    // Postgres date may arrive as 'YYYY-MM-DD' or ISO timestamp.
    return v.slice(0, 10)
  }
  // node-postgres parses a DATE column into a JS Date at SERVER-LOCAL
  // midnight. Converting through toISOString() (UTC) shifts the value back
  // one day whenever the server timezone is ahead of UTC (e.g. a VPS running
  // in MSK): «2026-08-07 00:00 MSK» -> «2026-08-06T21:00Z» -> "2026-08-06".
  // That off-by-one made leadNeedsDailyStatus() treat a just-confirmed status
  // as yesterday's, keeping the curator workspace locked. Read the LOCAL
  // calendar components instead — they match the stored date exactly.
  const y = v.getFullYear()
  const m = String(v.getMonth() + 1).padStart(2, '0')
  const d = String(v.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function toLeadCard(r: LeadCardRow): LeadCard {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    managerId: r.manager_id,
    managerName: r.manager_name,
    curatorId: r.curator_id,
    curatorName: r.curator_name,
    curatorCity: r.curator_city,
    fullName: r.full_name ?? '',
    phone: r.phone ?? '',
    telegramUsername: r.telegram_username ?? '',
    city: r.city ?? '',
    address: r.address ?? '',
    vacancy: r.vacancy ?? '',
    status: isLeadStatus(r.status) ? r.status : null,
    previousStatus: isLeadStatus(r.previous_status) ? r.previous_status : null,
    statusConfirmedAt: r.status_confirmed_at
      ? new Date(r.status_confirmed_at).toISOString()
      : null,
    statusConfirmedDate: toDateOnly(r.status_confirmed_date),
    transferredAt: r.transferred_at
      ? new Date(r.transferred_at).toISOString()
      : null,
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

function toComment(r: CommentRow): LeadCardComment {
  return {
    id: r.id,
    leadCardId: r.lead_card_id,
    authorId: r.author_id,
    authorName: r.author_name,
    body: r.body,
    status: isLeadStatus(r.status) ? r.status : null,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

export const CARD_SELECT = `
  lc.id, lc.conversation_id, lc.manager_id, lc.curator_id,
  lc.full_name, lc.phone, lc.telegram_username, lc.city, lc.address, lc.vacancy,
  lc.status, lc.previous_status, lc.status_confirmed_at, lc.status_confirmed_date,
  lc.transferred_at, lc.archived_at, lc.created_at, lc.updated_at,
  m.name AS manager_name,
  c.name AS curator_name,
  c.city AS curator_city
`

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

/*
 * Curator pickers moved to lead-curators.ts; re-exported for compatibility.
 */
export {
  findCuratorsByCity,
  listActiveCurators,
  type CuratorWithLoad,
} from './lead-curators'

export interface LeadStatusHistoryEntry {
  id: string
  status: LeadStatus | null
  curatorName: string | null
  reason: 'confirm' | 'transfer_reset'
  createdAt: string
}

/** Record one status-history event. Never throws. */
async function recordStatusHistory(input: {
  leadCardId: string
  curatorId: string | null
  status: LeadStatus | null
  reason: 'confirm' | 'transfer_reset'
}): Promise<void> {
  try {
    await query(
      `INSERT INTO lead_status_history (lead_card_id, curator_id, curator_name, status, reason)
       VALUES ($1, $2, (SELECT name FROM managers WHERE id = $2), $3, $4)`,
      [input.leadCardId, input.curatorId, input.status, input.reason],
    )
  } catch {
    /* history must never break the main write */
  }
}

export async function listLeadStatusHistory(
  leadCardId: string,
): Promise<LeadStatusHistoryEntry[]> {
  const rows = await query<{
    id: string
    status: string | null
    curator_name: string | null
    reason: string
    created_at: string | Date
  }>(
    `SELECT id, status, curator_name, reason, created_at
       FROM lead_status_history
      WHERE lead_card_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [leadCardId],
  )
  return rows.map((r) => ({
    id: r.id,
    status: isLeadStatus(r.status) ? r.status : null,
    curatorName: r.curator_name,
    reason: r.reason === 'transfer_reset' ? 'transfer_reset' : 'confirm',
    createdAt: new Date(r.created_at).toISOString(),
  }))
}

/** Record one transfer event with name snapshots. Never throws. */
async function recordTransfer(input: {
  leadCardId: string
  fromCuratorId: string | null
  toCuratorId: string
  initiatedById: string | null
  initiatedByRole: 'manager' | 'admin'
}): Promise<void> {
  try {
    await query(
      `INSERT INTO lead_transfers
         (id, lead_card_id, from_curator_id, to_curator_id,
          from_curator_name, to_curator_name, initiated_by, initiated_by_role)
       VALUES ($1, $2, $3, $4,
               (SELECT name FROM managers WHERE id = $3),
               (SELECT name FROM managers WHERE id = $4),
               $5, $6)`,
      [
        randomUUID(),
        input.leadCardId,
        input.fromCuratorId,
        input.toCuratorId,
        input.initiatedById,
        input.initiatedByRole,
      ],
    )
  } catch {
    /* history must never break the transfer itself */
  }
}

export async function listLeadTransfers(
  leadCardId: string,
): Promise<LeadTransfer[]> {
  const rows = await query<{
    id: string
    lead_card_id: string
    from_curator_name: string | null
    to_curator_name: string | null
    initiated_by_role: string
    created_at: string | Date
  }>(
    `SELECT id, lead_card_id, from_curator_name, to_curator_name,
            initiated_by_role, created_at
       FROM lead_transfers
      WHERE lead_card_id = $1
      ORDER BY created_at DESC`,
    [leadCardId],
  )
  return rows.map((r) => ({
    id: r.id,
    leadCardId: r.lead_card_id,
    fromCuratorName: r.from_curator_name,
    toCuratorName: r.to_curator_name,
    initiatedByRole: r.initiated_by_role,
    createdAt: new Date(r.created_at).toISOString(),
  }))
}

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
    ? `Возможный дубль: карточка «${who}» уже существует и закреплена за куратором ${dup.curator_name}.`
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

  const existing = await query<{
    id: string
    curator_id: string | null
  }>(
    `SELECT id, curator_id FROM lead_cards WHERE conversation_id = $1 LIMIT 1`,
    [input.conversationId],
  )

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
        'Лид уже закреплён за другим куратором. Переназначение выполняет администратор.',
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

/** Admin: (re)assign a lead to another active curator with a status reset. */
export async function transferLeadToCurator(
  leadCardId: string,
  newCuratorId: string,
): Promise<LeadCard> {
  const ok = await query<{ id: string }>(
    `SELECT id FROM managers
      WHERE id = $1 AND role = 'curator' AND status = 'active'
      LIMIT 1`,
    [newCuratorId],
  )
  if (!ok[0]) throw new Error('Curator not found or inactive')

  const prev = await query<{ curator_id: string | null }>(
    `SELECT curator_id FROM lead_cards WHERE id = $1 LIMIT 1`,
    [leadCardId],
  )
  if (!prev[0]) throw new Error('Лид не найден')

  const rows = await query<{ id: string }>(
    `UPDATE lead_cards
        SET curator_id = $2,
            transferred_at = now(),
            -- New curator must confirm status for today.
            status = NULL,
            previous_status = COALESCE(status, previous_status),
            status_confirmed_at = NULL,
            status_confirmed_date = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING id`,
    [leadCardId, newCuratorId],
  )
  if (!rows[0]) throw new Error('Лид не найден')

  await recordTransfer({
    leadCardId,
    fromCuratorId: prev[0].curator_id,
    toCuratorId: newCuratorId,
    initiatedById: null,
    initiatedByRole: 'admin',
  })
  await recordStatusHistory({
    leadCardId,
    curatorId: newCuratorId,
    status: null,
    reason: 'transfer_reset',
  })

  const card = await getLeadCardById(rows[0].id)
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

  const existing = await query<{
    id: string
    curator_id: string | null
    status: string | null
    status_confirmed_date: string | Date | null
  }>(
    `SELECT id, curator_id, status, status_confirmed_date
       FROM lead_cards WHERE id = $1 LIMIT 1`,
    [input.leadCardId],
  )
  const row = existing[0]
  if (!row) throw new Error('Лид не найден')
  if (row.curator_id !== input.curatorId) {
    throw new Error('Этот лид принадлежит другому куратору')
  }

  const today = mskDayKey(new Date())
  const prevDate = toDateOnly(row.status_confirmed_date)
  const carryPrevious =
    isLeadStatus(row.status) && prevDate && prevDate !== today
      ? row.status
      : null

  await query(
    `UPDATE lead_cards
        SET previous_status = COALESCE($3, previous_status),
            status = $2,
            status_confirmed_at = now(),
            status_confirmed_date = $4::date,
            updated_at = now()
      WHERE id = $1`,
    [input.leadCardId, input.status, carryPrevious, today],
  )

  await query(
    `INSERT INTO lead_card_comments (id, lead_card_id, author_id, author_name, body, status)
     VALUES ($1, $2, $3, (SELECT name FROM managers WHERE id = $3), $4, $5)`,
    [randomUUID(), input.leadCardId, input.curatorId, comment, input.status],
  )

  await recordStatusHistory({
    leadCardId: input.leadCardId,
    curatorId: input.curatorId,
    status: input.status,
    reason: 'confirm',
  })

  const card = await getLeadCardById(input.leadCardId)
  if (!card) throw new Error('Status update failed')
  return card
}

/** Free-form comment without changing status (optional helper). */
export async function addLeadComment(input: {
  leadCardId: string
  authorId: string
  body: string
}): Promise<LeadCardComment> {
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

/* ----------------------------- Admin overview ----------------------------- */

export interface AllLeadsFilter {
  curatorId?: string | null
  status?: LeadStatus | 'none' | null
  city?: string | null
  /** Inclusive MSK period applied to the transfer day (YYYY-MM-DD). */
  from?: string | null
  to?: string | null
  /** Only leads transferred but currently without a curator. */
  orphanedOnly?: boolean
  /** Show archived leads instead of active ones. */
  archivedOnly?: boolean
  limit?: number
  offset?: number
}

/** Admin: all transferred leads with optional filters, newest first. */
export async function listAllTransferredLeads(
  filter: AllLeadsFilter = {},
): Promise<{ leads: LeadCard[]; total: number }> {
  const conds: string[] = [
    'lc.transferred_at IS NOT NULL',
    filter.archivedOnly
      ? 'lc.archived_at IS NOT NULL'
      : 'lc.archived_at IS NULL',
  ]
  const params: unknown[] = []

  if (filter.orphanedOnly) {
    conds.push('lc.curator_id IS NULL')
  } else if (filter.curatorId) {
    params.push(filter.curatorId)
    conds.push(`lc.curator_id = $${params.length}`)
  }
  if (filter.status === 'none') {
    conds.push('lc.status IS NULL')
  } else if (filter.status) {
    params.push(filter.status)
    conds.push(`lc.status = $${params.length}`)
  }
  if (filter.city?.trim()) {
    params.push(`%${filter.city.trim()}%`)
    conds.push(`lower(lc.city) LIKE lower($${params.length})`)
  }
  // Period over the transfer day in MSK (validated YYYY-MM-DD only).
  const dayRe = /^\d{4}-\d{2}-\d{2}$/
  if (filter.from && dayRe.test(filter.from)) {
    params.push(filter.from)
    conds.push(
      `(lc.transferred_at AT TIME ZONE 'Europe/Moscow')::date >= $${params.length}::date`,
    )
  }
  if (filter.to && dayRe.test(filter.to)) {
    params.push(filter.to)
    conds.push(
      `(lc.transferred_at AT TIME ZONE 'Europe/Moscow')::date <= $${params.length}::date`,
    )
  }

  const where = conds.join(' AND ')
  const totalRows = await query<{ n: string }>(
    `SELECT count(*)::int AS n FROM lead_cards lc WHERE ${where}`,
    params,
  )

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  params.push(limit, offset)

  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE ${where}
      ORDER BY lc.transferred_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return { leads: rows.map(toLeadCard), total: Number(totalRows[0]?.n ?? 0) }
}

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
