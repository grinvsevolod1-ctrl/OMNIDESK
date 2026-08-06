/**
 * Lead cards: structured lead data filled from a conversation and optionally
 * transferred to a curator matched by city.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
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
  transferredAt: string | null
  createdAt: string
  updatedAt: string
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
  transferred_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
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
    transferredAt: r.transferred_at
      ? new Date(r.transferred_at).toISOString()
      : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

const CARD_SELECT = `
  lc.id, lc.conversation_id, lc.manager_id, lc.curator_id,
  lc.full_name, lc.phone, lc.telegram_username, lc.city, lc.address, lc.vacancy,
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

/**
 * Create or update the lead card for a conversation. When curatorId is provided
 * and valid, sets transferred_at = now().
 */
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
    const rows = await query<LeadCardRow>(
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

async function getLeadCardById(id: string): Promise<LeadCard | null> {
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
