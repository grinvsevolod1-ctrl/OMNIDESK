/**
 * Lead cards: structured lead data filled from a conversation and optionally
 * transferred to a curator matched by city. Curators maintain a daily status
 * and comment trail on each transferred lead.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
import {
  isLeadStatus,
  type LeadStatus,
  STATUS_COMMENT_MIN_LEN,
} from '../lead-status'
import { mskDayKey } from '../time'
import type { Manager } from '../types'
import { managerColumns, toManager, type ManagerRow } from './shared'

export interface LeadCard {
  id: string
  conversationId: string | null
  managerId: string
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
  createdAt: string
  updatedAt: string
}

export interface LeadCardComment {
  id: string
  leadCardId: string
  authorId: string
  authorName: string | null
  body: string
  status: LeadStatus | null
  createdAt: string
}

interface LeadCardRow {
  id: string
  conversation_id: string | null
  manager_id: string
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
  created_at: string | Date
  updated_at: string | Date
}

interface CommentRow {
  id: string
  lead_card_id: string
  author_id: string
  author_name: string | null
  body: string
  status: string | null
  created_at: string | Date
}

function toDateOnly(v: string | Date | null | undefined): string | null {
  if (!v) return null
  if (typeof v === 'string') {
    // Postgres date may arrive as 'YYYY-MM-DD' or ISO timestamp.
    return v.slice(0, 10)
  }
  return v.toISOString().slice(0, 10)
}

function toLeadCard(r: LeadCardRow): LeadCard {
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

const CARD_SELECT = `
  lc.id, lc.conversation_id, lc.manager_id, lc.curator_id,
  lc.full_name, lc.phone, lc.telegram_username, lc.city, lc.address, lc.vacancy,
  lc.status, lc.previous_status, lc.status_confirmed_at, lc.status_confirmed_date,
  lc.transferred_at, lc.created_at, lc.updated_at,
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
      ORDER BY lc.transferred_at DESC`,
    [curatorId],
  )
  return rows.map(toLeadCard)
}

/** Active curators whose city matches (case-insensitive contains) the query. */
export async function findCuratorsByCity(cityQuery: string): Promise<Manager[]> {
  const q = cityQuery.trim()
  if (!q) return []
  const rows = await query<ManagerRow>(
    `SELECT ${managerColumns()}
       FROM managers
      WHERE role = 'curator'
        AND status = 'active'
        AND city IS NOT NULL
        AND lower(city) LIKE lower($1)
      ORDER BY city ASC, name ASC
      LIMIT 20`,
    [`%${q}%`],
  )
  return rows.map(toManager)
}

/** All active curators (for admin transfer picker). */
export async function listActiveCurators(): Promise<Manager[]> {
  const rows = await query<ManagerRow>(
    `SELECT ${managerColumns()}
       FROM managers
      WHERE role = 'curator' AND status = 'active'
      ORDER BY city ASC NULLS LAST, name ASC`,
  )
  return rows.map(toManager)
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
}

export async function upsertLeadCard(
  input: UpsertLeadCardInput,
): Promise<LeadCard> {
  const fullName = input.fullName.trim()
  const phone = input.phone.trim()
  const telegramUsername = input.telegramUsername.trim().replace(/^@/, '')
  const city = input.city.trim()
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

  const existing = await query<{ id: string }>(
    `SELECT id FROM lead_cards WHERE conversation_id = $1 LIMIT 1`,
    [input.conversationId],
  )

  if (existing[0]) {
    const rows = await query<{ id: string }>(
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
                WHEN $9::uuid IS NOT NULL THEN now()
                ELSE transferred_at
              END,
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
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
      ],
    )
    const card = await getLeadCardById(rows[0].id)
    if (!card) throw new Error('Lead card update failed')
    return card
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
  const card = await getLeadCardById(id)
  if (!card) throw new Error('Lead card create failed')
  return card
}

/** Admin: reassign a transferred lead to another active curator. */
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
      WHERE id = $1 AND transferred_at IS NOT NULL
      RETURNING id`,
    [leadCardId, newCuratorId],
  )
  if (!rows[0]) throw new Error('Lead not found or not transferred yet')
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
    `INSERT INTO lead_card_comments (id, lead_card_id, author_id, body, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), input.leadCardId, input.curatorId, comment, input.status],
  )

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
    `INSERT INTO lead_card_comments (id, lead_card_id, author_id, body, status)
     VALUES ($1, $2, $3, $4, NULL)
     RETURNING id, lead_card_id, author_id, body, status, created_at,
               (SELECT name FROM managers WHERE id = $3) AS author_name`,
    [id, input.leadCardId, input.authorId, body],
  )
  return toComment(rows[0])
}

export async function listLeadComments(
  leadCardId: string,
): Promise<LeadCardComment[]> {
  const rows = await query<CommentRow>(
    `SELECT c.id, c.lead_card_id, c.author_id, c.body, c.status, c.created_at,
            m.name AS author_name
       FROM lead_card_comments c
       LEFT JOIN managers m ON m.id = c.author_id
      WHERE c.lead_card_id = $1
      ORDER BY c.created_at DESC`,
    [leadCardId],
  )
  return rows.map(toComment)
}

/** Count of leads a curator still must confirm today (after deadline logic is client-side). */
export async function countLeadsNeedingStatus(
  curatorId: string,
  todayMsk: string,
): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::int AS n
       FROM lead_cards
      WHERE curator_id = $1
        AND transferred_at IS NOT NULL
        AND (status_confirmed_date IS NULL OR status_confirmed_date < $2::date)`,
    [curatorId, todayMsk],
  )
  return Number(rows[0]?.n ?? 0)
}
