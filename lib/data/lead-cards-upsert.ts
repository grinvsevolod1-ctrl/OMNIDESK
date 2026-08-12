/**
 * Lead cards: create/update from the manager's lead form — contact-identity
 * dedup, duplicate warnings, transfer-on-upsert semantics.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
import { normalizeCityName, rememberCity } from './cities'
import type { LeadCard } from './lead-cards-core'
import { recordStatusHistory, recordTransfer } from './lead-history'
import {
  findLeadCardForContact,
  getLeadCardById,
} from './lead-cards-queries'

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
      existing = [{ id: contactMatch.id, curator_id: contactMatch.curatorId }]
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

    const isFreshTransfer = curatorId !== null && curatorId !== prevCuratorId

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
