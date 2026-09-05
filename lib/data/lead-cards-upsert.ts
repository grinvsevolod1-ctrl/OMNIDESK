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
  /** Числовой Telegram ID — отдельно от телефона (миграция 130). */
  telegramId: string
  city: string
  address: string
  vacancy: string
  /** When set, the card is transferred to this curator (admin/legacy direct assign). */
  curatorId?: string | null
  /**
   * When set (and no curatorId), the card is routed to this TEAM'S POOL
   * (миграция 150): team_id проставляется, curator_id остаётся NULL, лид
   * разбирают кураторы вручную (claim). Основной путь передачи для менеджера.
   */
  teamId?: string | null
  /** True when the caller is an admin (may reassign an already-assigned lead). */
  isAdmin?: boolean
}

export interface UpsertLeadCardResult {
  card: LeadCard
  /** True when the curator changed in this call (fresh transfer happened). */
  transferred: boolean
  /** True when the lead was freshly routed to a team pool in this call. */
  pooled: boolean
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

/**
 * ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ для статуса «Передан».
 *
 * В момент реальной передачи лида (в пул команды ИЛИ прямо куратору) статус
 * диалога в инбоксе менеджера становится «Передан» (conversations.status =
 * 'transferred'). Раньше «Передан» проставлялся вручную и жил ОТДЕЛЬНО от факта
 * передачи — получалось два несвязанных «Передан». Теперь статус инбокса всегда
 * выводится из факта передачи: одна операция передачи → один статус.
 */
async function markConversationTransferred(
  conversationId: string,
): Promise<void> {
  await query(
    `UPDATE conversations
        SET status = 'transferred',
            status_detail = NULL,
            status_updated_at = now()
      WHERE id = $1`,
    [conversationId],
  )
}

export async function upsertLeadCard(
  input: UpsertLeadCardInput,
): Promise<UpsertLeadCardResult> {
  const fullName = input.fullName.trim()
  const phone = input.phone.trim()
  const telegramUsername = input.telegramUsername.trim().replace(/^@/, '')
  const telegramId = input.telegramId.trim()
  // Canonical spelling from the city dictionary («москва» -> «Москва»).
  const city = normalizeCityName(input.city)
    ? await rememberCity(input.city).catch(() => normalizeCityName(input.city))
    : ''
  const address = input.address.trim()
  const vacancy = input.vacancy.trim()
  const curatorId = input.curatorId?.trim() || null
  // Пуловая маршрутизация в команду — только если явный куратор не задан.
  const teamId = !curatorId ? input.teamId?.trim() || null : null

  if (curatorId) {
    const ok = await query<{ id: string }>(
      `SELECT id FROM managers
        WHERE id = $1 AND role = 'curator' AND status = 'active'
        LIMIT 1`,
      [curatorId],
    )
    if (!ok[0]) throw new Error('Curator not found or inactive')
  }
  if (teamId) {
    const ok = await query<{ id: string }>(
      `SELECT id FROM teams WHERE id = $1 LIMIT 1`,
      [teamId],
    )
    if (!ok[0]) throw new Error('Команда не найдена')
  }

  let existing = await query<{
    id: string
    curator_id: string | null
    team_id: string | null
  }>(
    `SELECT id, curator_id, team_id FROM lead_cards WHERE conversation_id = $1 LIMIT 1`,
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
        {
          id: contactMatch.id,
          curator_id: contactMatch.curatorId,
          team_id: contactMatch.teamId,
        },
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
    const prevTeamId = existing[0].team_id

    // Пуловая маршрутизация в команду: лид «только зашёл» и ещё не разобран.
    // Свежая маршрутизация — только если лид не закреплён за куратором и ещё
    // не в пуле (повторное сохранение менеджером не плодит передачи).
    if (teamId) {
      const isFreshPool = prevCuratorId === null && prevTeamId === null
      await query(
        `UPDATE lead_cards
            SET full_name = $2, phone = $3, telegram_username = $4,
                telegram_id = $5, city = $6, address = $7, vacancy = $8,
                manager_id = $9,
                team_id = CASE WHEN $11::boolean THEN $10 ELSE team_id END,
                transferred_at = CASE WHEN $11::boolean THEN now() ELSE transferred_at END,
                status = CASE WHEN $11::boolean THEN 'new' ELSE status END,
                previous_status = CASE
                  WHEN $11::boolean THEN COALESCE(status, previous_status)
                  ELSE previous_status END,
                status_confirmed_at = CASE WHEN $11::boolean THEN NULL ELSE status_confirmed_at END,
                status_confirmed_date = CASE WHEN $11::boolean THEN NULL ELSE status_confirmed_date END,
                updated_at = now()
          WHERE id = $1`,
        [
          existing[0].id,
          fullName,
          phone,
          telegramUsername,
          telegramId,
          city,
          address,
          vacancy,
          input.managerId,
          teamId,
          isFreshPool,
        ],
      )
      // Свежая пуловая передача — диалог помечается «Передан» в инбоксе.
      if (isFreshPool) await markConversationTransferred(input.conversationId)
      const card = await getLeadCardById(existing[0].id)
      if (!card) throw new Error('Lead card update failed')
      return {
        card,
        transferred: false,
        pooled: isFreshPool,
        duplicateWarning,
      }
    }

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
              telegram_id = $5,
              city = $6,
              address = $7,
              vacancy = $8,
              manager_id = $9,
              curator_id = COALESCE($10, curator_id),
              transferred_at = CASE
                WHEN $11::boolean THEN now()
                ELSE transferred_at
              END,
              -- Свежая передача: лид «только зашёл» — статус NEW; куратор
              -- всё равно обязан подтвердить реальный статус сегодня.
              status = CASE WHEN $11::boolean THEN 'new' ELSE status END,
              previous_status = CASE
                WHEN $11::boolean THEN COALESCE(status, previous_status)
                ELSE previous_status
              END,
              status_confirmed_at = CASE
                WHEN $11::boolean THEN NULL ELSE status_confirmed_at
              END,
              status_confirmed_date = CASE
                WHEN $11::boolean THEN NULL ELSE status_confirmed_date
              END,
              updated_at = now()
        WHERE id = $1`,
      [
        existing[0].id,
        fullName,
        phone,
        telegramUsername,
        telegramId,
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
      // Прямая передача куратору — «Передан» в инбоксе менеджера.
      await markConversationTransferred(input.conversationId)
    }

    const card = await getLeadCardById(existing[0].id)
    if (!card) throw new Error('Lead card update failed')
    return { card, transferred: isFreshTransfer, pooled: false, duplicateWarning }
  }

  const id = randomUUID()
  // Свежесозданная карточка передаётся сразу, если задан куратор (legacy/admin)
  // ЛИБО команда (пуловая маршрутизация): в обоих случаях transferred_at = now,
  // статус NEW. team_id заполняется только для пуловой ветки.
  const transferredNow = Boolean(curatorId) || Boolean(teamId)
  await query(
    `INSERT INTO lead_cards (
       id, conversation_id, manager_id, curator_id, team_id,
       full_name, phone, telegram_username, telegram_id, city, address, vacancy,
       transferred_at, status, traffic_source_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               CASE WHEN $13::boolean THEN now() ELSE NULL END,
               CASE WHEN $13::boolean THEN 'new' ELSE NULL END,
               (SELECT traffic_source_id FROM managers WHERE id = $3))`,
    [
      id,
      input.conversationId,
      input.managerId,
      curatorId,
      teamId,
      fullName,
      phone,
      telegramUsername,
      telegramId,
      city,
      address,
      vacancy,
      transferredNow,
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
  // Новая карточка, созданная сразу с передачей (куратор или пул) — «Передан».
  if (transferredNow) await markConversationTransferred(input.conversationId)

  const card = await getLeadCardById(id)
  if (!card) throw new Error('Lead card create failed')
  return {
    card,
    transferred: Boolean(curatorId),
    pooled: Boolean(teamId),
    duplicateWarning,
  }
}
