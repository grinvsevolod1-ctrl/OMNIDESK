/**
 * Админский срез по лидам: общая выборка с фильтрами/поиском, корзина
 * (мягкое удаление) и inline-редактирование полей из таблицы.
 * Вынесено из lead-cards.ts (распил монолита).
 */
import { query, withTransaction } from '../db'
import type { LeadStatus } from '../lead-status'
import {
  CARD_SELECT,
  toLeadCard,
  type LeadCard,
  type LeadCardRow,
} from './lead-cards-core'
import { rememberCity } from './cities'

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
  /** Единый поиск: дата (ДД.ММ.ГГГГ), @username, телефон, город, регион, ФИО. */
  search?: string | null
  /** Сортировка по дате передачи. По умолчанию новые сверху. */
  sort?: 'newest' | 'oldest'
  limit?: number
  offset?: number
}

/**
 * Разбор поискового запроса: дата ДД.ММ.ГГГГ (или ГГГГ-ММ-ДД) становится
 * фильтром по дню передачи в МСК, остальное — текстовым поиском.
 */
export function parseLeadSearch(raw: string): {
  day: string | null
  text: string
} {
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  const ru = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (ru) return { day: `${ru[3]}-${ru[2]}-${ru[1]}`, text: '' }
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return { day: trimmed, text: '' }
  return { day: null, text: trimmed }
}

/** Admin: all transferred leads with optional filters, newest first. */
export async function listAllTransferredLeads(
  filter: AllLeadsFilter = {},
): Promise<{ leads: LeadCard[]; total: number }> {
  const conds: string[] = [
    'lc.transferred_at IS NOT NULL',
    'lc.deleted_at IS NULL',
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

  // Единый поиск: одно поле — дата / ФИО / телефон / @username / город / регион.
  if (filter.search?.trim()) {
    const { day, text } = parseLeadSearch(filter.search)
    if (day) {
      params.push(day)
      conds.push(
        `(lc.transferred_at AT TIME ZONE 'Europe/Moscow')::date = $${params.length}::date`,
      )
    } else if (text) {
      const like = `%${text.replace(/^@/, '')}%`
      params.push(like)
      const p = `$${params.length}`
      conds.push(
        `(lower(lc.full_name) LIKE lower(${p})
          OR lc.phone LIKE ${p}
          OR lower(lc.telegram_username) LIKE lower(${p})
          OR lower(lc.city) LIKE lower(${p})
          OR EXISTS (
               SELECT 1 FROM cities ci
               JOIN regions rg ON rg.id = ci.region_id
              WHERE ci.name_norm = lower(lc.city)
                AND lower(rg.name) LIKE lower(${p})
             ))`,
      )
    }
  }

  const where = conds.join(' AND ')
  const totalRows = await query<{ n: string }>(
    `SELECT count(*)::int AS n FROM lead_cards lc WHERE ${where}`,
    params,
  )

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  params.push(limit, offset)

  const order = filter.sort === 'oldest' ? 'ASC' : 'DESC'
  const rows = await query<LeadCardRow & { region_name: string | null }>(
    `SELECT ${CARD_SELECT},
            (SELECT rg.name FROM cities ci
              JOIN regions rg ON rg.id = ci.region_id
             WHERE ci.name_norm = lower(lc.city) LIMIT 1) AS region_name
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE ${where}
      ORDER BY lc.transferred_at ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return {
    leads: rows.map((r) => ({ ...toLeadCard(r), region: r.region_name })),
    total: Number(totalRows[0]?.n ?? 0),
  }
}

/* ------------------------- Мягкое удаление (корзина) ------------------------ */

/**
 * Мягкое удаление лида админом: карточка уходит в «Корзину» с обязательной
 * причиной, вся история сохраняется. Автоочистка — purgeDeletedLeads (30 дней).
 */
export async function softDeleteLeadCard(input: {
  leadCardId: string
  reason: string
  deletedById: string | null
  deletedByName?: string | null
}): Promise<void> {
  const reason = input.reason.replace(/\s+/g, ' ').trim()
  if (reason.length < 3) {
    throw new Error('Укажите причину удаления (минимум 3 символа)')
  }
  await withTransaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `UPDATE lead_cards
          SET deleted_at = now(), deleted_reason = $2, deleted_by = $3,
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [input.leadCardId, reason, input.deletedById],
    )
    if (rows.length === 0) throw new Error('Лид не найден или уже удалён')
    await tx.query(
      `INSERT INTO lead_status_history
         (lead_card_id, curator_id, curator_name, status, reason)
       VALUES ($1, $2, $3, NULL, $4)`,
      [
        input.leadCardId,
        input.deletedById,
        input.deletedByName ?? null,
        `deleted: ${reason}`,
      ],
    )
  })
}

/** Восстановление лида из корзины. */
export async function restoreLeadCard(input: {
  leadCardId: string
  restoredById: string | null
  restoredByName?: string | null
}): Promise<void> {
  await withTransaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `UPDATE lead_cards
          SET deleted_at = NULL, deleted_reason = NULL, deleted_by = NULL,
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NOT NULL
        RETURNING id`,
      [input.leadCardId],
    )
    if (rows.length === 0) throw new Error('Лид не найден в корзине')
    await tx.query(
      `INSERT INTO lead_status_history
         (lead_card_id, curator_id, curator_name, status, reason)
       VALUES ($1, $2, $3, NULL, 'restored')`,
      [input.leadCardId, input.restoredById, input.restoredByName ?? null],
    )
  })
}

export interface DeletedLead extends LeadCard {
  deletedAt: string
  deletedReason: string
  deletedByName: string | null
}

/** Корзина: удалённые лиды, свежие сверху. */
export async function listDeletedLeads(
  limit = 100,
): Promise<DeletedLead[]> {
  const rows = await query<
    LeadCardRow & {
      deleted_at: string | Date
      deleted_reason: string | null
      deleted_by_name: string | null
    }
  >(
    `SELECT ${CARD_SELECT},
            lc.deleted_at, lc.deleted_reason,
            d.name AS deleted_by_name
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
       LEFT JOIN managers d ON d.id = lc.deleted_by
      WHERE lc.deleted_at IS NOT NULL
      ORDER BY lc.deleted_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
  )
  return rows.map((r) => ({
    ...toLeadCard(r),
    deletedAt: new Date(r.deleted_at).toISOString(),
    deletedReason: r.deleted_reason ?? '',
    deletedByName: r.deleted_by_name,
  }))
}

/** Автоочистка корзины: физически удаляет лиды старше N дней. Возврат: сколько удалено. */
export async function purgeDeletedLeads(olderThanDays = 30): Promise<number> {
  const days = Math.max(1, Math.floor(olderThanDays))
  const rows = await query<{ id: string }>(
    `DELETE FROM lead_cards
      WHERE deleted_at IS NOT NULL
        AND deleted_at < now() - make_interval(days => $1)
      RETURNING id`,
    [days],
  )
  return rows.length
}

/* --------------------- Inline-редактирование одного поля -------------------- */

const INLINE_EDITABLE_FIELDS = {
  full_name: 160,
  phone: 40,
  telegram_username: 80,
  city: 120,
  address: 300,
  vacancy: 80,
} as const

export type InlineLeadField = keyof typeof INLINE_EDITABLE_FIELDS

export function isInlineLeadField(f: string): f is InlineLeadField {
  return f in INLINE_EDITABLE_FIELDS
}

/**
 * Обновление одного поля карточки из строки таблицы (без открытия диалога).
 * Город запоминается в справочнике; поле whitelisted — SQL-инъекция исключена.
 */
export async function updateLeadCardField(input: {
  leadCardId: string
  field: InlineLeadField
  value: string
}): Promise<void> {
  if (!isInlineLeadField(input.field)) {
    throw new Error('Это поле нельзя редактировать из таблицы')
  }
  let value = input.value.replace(/\s+/g, ' ').trim()
  const maxLen = INLINE_EDITABLE_FIELDS[input.field]
  if (value.length > maxLen) {
    throw new Error(`Слишком длинное значение (максимум ${maxLen})`)
  }
  if (input.field === 'telegram_username') {
    value = value.replace(/^@/, '')
  }
  if (input.field === 'city' && value) {
    value = await rememberCity(value)
  }
  const rows = await query<{ id: string }>(
    `UPDATE lead_cards
        SET ${input.field} = $2, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [input.leadCardId, value],
  )
  if (rows.length === 0) throw new Error('Лид не найден')
}
