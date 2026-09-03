/**
 * Lead cards: read-side queries — lookup by conversation/id, contact-identity
 * dedup probe, curator lists (active + archive).
 */
import { query } from '../db'
import {
  CARD_SELECT,
  toLeadCard,
  type LeadCard,
  type LeadCardRow,
} from './lead-cards-core'

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

/**
 * Рабочее место куратора: ЗАКРЕПЛЁННЫЕ за ним лиды + ПУЛОВЫЕ лиды его команды,
 * которые ему «светятся» (миграция 150). Пуловый лид виден, пока он не взят
 * (curator_id IS NULL) и не в архиве, а куратору он адресован через
 * уведомление lead_pool_available (город матчится по региону при передаче —
 * единый источник правды сопоставления). Пуловые (isPool) идут первыми,
 * затем закреплённые по времени передачи.
 */
export async function listLeadCardsForCurator(
  curatorId: string,
): Promise<LeadCard[]> {
  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.archived_at IS NULL
        AND (
          (lc.curator_id = $1 AND lc.transferred_at IS NOT NULL)
          OR (
            lc.curator_id IS NULL
            AND lc.team_id = (SELECT team_id FROM managers WHERE id = $1)
            AND lc.team_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM lead_notifications ln
               WHERE ln.lead_card_id = lc.id
                 AND ln.recipient_id = $1
                 AND ln.kind = 'lead_pool_available'
            )
          )
        )
      ORDER BY (lc.curator_id IS NULL) DESC,
               COALESCE(lc.transferred_at, lc.created_at) DESC`,
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
