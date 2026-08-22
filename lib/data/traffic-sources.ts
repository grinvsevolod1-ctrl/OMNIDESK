/**
 * Источники трафика (миграция 145): каждый источник ведёт один медиабайер
 * (role = 'buyer'), к источнику подключаются менеджеры продаж
 * (managers.traffic_source_id), лиды фиксируют источник на момент обращения
 * (lead_cards.traffic_source_id — денормализация сознательная).
 *
 * Окно «дня» источника — [dayStart, dayEnd) в минутах от полуночи МСК;
 * «долёты» — всё остальное время суток. Умолчания 09:00–18:00.
 */
import { randomUUID } from 'crypto'
import { query, withTransaction } from '../db'
import type { Manager } from '../types'
import {
  excludeAdminSql,
  managerColumns,
  toManager,
  type ManagerRow,
} from './shared'
import {
  CARD_SELECT,
  toLeadCard,
  type LeadCard,
  type LeadCardRow,
} from './lead-cards-core'

/* ------------------------------- Типы ------------------------------- */

export interface TrafficSource {
  id: string
  name: string
  buyerId: string | null
  buyerName: string | null
  /** Минуты от полуночи МСК, [0, 1440). Окно дня — [dayStart, dayEnd). */
  dayStart: number
  dayEnd: number
  notes: string | null
  isActive: boolean
  createdAt: string
  /** Подключённые менеджеры продаж (для списков). */
  managerCount: number
  /** Всего лидов, атрибутированных источнику. */
  leadCount: number
}

interface TrafficSourceRow {
  id: string
  name: string
  buyer_id: string | null
  buyer_name: string | null
  day_start: number
  day_end: number
  notes: string | null
  is_active: boolean
  created_at: string | Date
  manager_count: number
  lead_count: number
}

function toTrafficSource(row: TrafficSourceRow): TrafficSource {
  return {
    id: row.id,
    name: row.name,
    buyerId: row.buyer_id,
    buyerName: row.buyer_name,
    dayStart: row.day_start,
    dayEnd: row.day_end,
    notes: row.notes,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
    managerCount: row.manager_count,
    leadCount: row.lead_count,
  }
}

const SOURCE_SELECT = `
  ts.id, ts.name, ts.buyer_id, b.name AS buyer_name,
  ts.day_start, ts.day_end, ts.notes, ts.is_active, ts.created_at,
  (SELECT COUNT(*)::int FROM managers m
    WHERE m.traffic_source_id = ts.id AND m.role = 'manager') AS manager_count,
  (SELECT COUNT(*)::int FROM lead_cards lc
    WHERE lc.traffic_source_id = ts.id AND lc.deleted_at IS NULL) AS lead_count`

/* ----------------------------- Байеры ------------------------------- */

/** Учётки медиабайеров (role = 'buyer'), новые сверху. */
export async function listBuyers(): Promise<Manager[]> {
  const rows = await query<ManagerRow>(
    `SELECT ${managerColumns()} FROM managers
      WHERE role = 'buyer' ${excludeAdminSql('managers')}
      ORDER BY created_at DESC`,
  )
  return rows.map(toManager)
}

/* --------------------------- Источники CRUD -------------------------- */

/** Все источники (админ), с байером и счётчиками. Активные сверху. */
export async function listTrafficSources(): Promise<TrafficSource[]> {
  const rows = await query<TrafficSourceRow>(
    `SELECT ${SOURCE_SELECT}
       FROM traffic_sources ts
       LEFT JOIN managers b ON b.id = ts.buyer_id
      ORDER BY ts.is_active DESC, ts.created_at DESC`,
  )
  return rows.map(toTrafficSource)
}

/** Источники конкретного байера (раздел /buyer). */
export async function listTrafficSourcesForBuyer(
  buyerId: string,
): Promise<TrafficSource[]> {
  const rows = await query<TrafficSourceRow>(
    `SELECT ${SOURCE_SELECT}
       FROM traffic_sources ts
       LEFT JOIN managers b ON b.id = ts.buyer_id
      WHERE ts.buyer_id = $1
      ORDER BY ts.is_active DESC, ts.created_at DESC`,
    [buyerId],
  )
  return rows.map(toTrafficSource)
}

export async function getTrafficSourceById(
  id: string,
): Promise<TrafficSource | null> {
  const rows = await query<TrafficSourceRow>(
    `SELECT ${SOURCE_SELECT}
       FROM traffic_sources ts
       LEFT JOIN managers b ON b.id = ts.buyer_id
      WHERE ts.id = $1 LIMIT 1`,
    [id],
  )
  return rows[0] ? toTrafficSource(rows[0]) : null
}

function validateWindow(dayStart: number, dayEnd: number): void {
  if (
    !Number.isInteger(dayStart) ||
    !Number.isInteger(dayEnd) ||
    dayStart < 0 ||
    dayStart >= 1440 ||
    dayEnd <= 0 ||
    dayEnd > 1440 ||
    dayStart >= dayEnd
  ) {
    throw new Error(
      'Некорректное окно дня: начало должно быть раньше конца в пределах суток.',
    )
  }
}

export async function createTrafficSource(input: {
  name: string
  buyerId: string | null
  dayStart?: number
  dayEnd?: number
  notes?: string | null
}): Promise<TrafficSource> {
  const name = input.name.trim()
  if (!name) throw new Error('Укажите название источника.')
  const dayStart = input.dayStart ?? 540
  const dayEnd = input.dayEnd ?? 1080
  validateWindow(dayStart, dayEnd)
  const id = randomUUID()
  await query(
    `INSERT INTO traffic_sources (id, name, buyer_id, day_start, day_end, notes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, name, input.buyerId, dayStart, dayEnd, input.notes?.trim() || null],
  )
  const created = await getTrafficSourceById(id)
  if (!created) throw new Error('Source create failed')
  return created
}

export async function updateTrafficSource(input: {
  id: string
  name: string
  buyerId: string | null
  dayStart: number
  dayEnd: number
  notes?: string | null
  isActive: boolean
}): Promise<TrafficSource> {
  const name = input.name.trim()
  if (!name) throw new Error('Укажите название источника.')
  validateWindow(input.dayStart, input.dayEnd)
  await query(
    `UPDATE traffic_sources
        SET name = $2, buyer_id = $3, day_start = $4, day_end = $5,
            notes = $6, is_active = $7, updated_at = now()
      WHERE id = $1`,
    [
      input.id,
      name,
      input.buyerId,
      input.dayStart,
      input.dayEnd,
      input.notes?.trim() || null,
      input.isActive,
    ],
  )
  const updated = await getTrafficSourceById(input.id)
  if (!updated) throw new Error('Источник не найден.')
  return updated
}

/**
 * Удаление источника. FK у managers/lead_cards — ON DELETE SET NULL:
 * привязки менеджеров и атрибуция лидов обнуляются, сами данные целы.
 */
export async function deleteTrafficSource(id: string): Promise<void> {
  await query(`DELETE FROM traffic_sources WHERE id = $1`, [id])
}

/* ----------------------- Менеджеры источника ------------------------ */

/** Менеджеры продаж, подключённые к источнику. */
export async function listManagersOfSource(
  sourceId: string,
): Promise<Manager[]> {
  const rows = await query<ManagerRow>(
    `SELECT ${managerColumns()} FROM managers
      WHERE traffic_source_id = $1 AND role = 'manager'
      ORDER BY name`,
    [sourceId],
  )
  return rows.map(toManager)
}

/** Который источник у менеджера (для админ-таблиц). */
export async function mapManagerSources(): Promise<
  Map<string, { sourceId: string; sourceName: string }>
> {
  const rows = await query<{
    id: string
    source_id: string
    source_name: string
  }>(
    `SELECT m.id, ts.id AS source_id, ts.name AS source_name
       FROM managers m
       JOIN traffic_sources ts ON ts.id = m.traffic_source_id
      WHERE m.role = 'manager'`,
  )
  const out = new Map<string, { sourceId: string; sourceName: string }>()
  for (const r of rows) {
    out.set(r.id, { sourceId: r.source_id, sourceName: r.source_name })
  }
  return out
}

/**
 * Полная замена состава менеджеров источника. Менеджер подключён максимум
 * к одному источнику: выбранные сначала выводятся из чужих источников.
 * Атрибуция существующих лидов НЕ переписывается (источник фиксируется
 * на момент обращения) — меняется только привязка для будущих лидов.
 */
export async function setSourceManagers(
  sourceId: string,
  managerIds: string[],
): Promise<void> {
  const unique = [...new Set(managerIds)].filter(Boolean)
  const valid =
    unique.length > 0
      ? await query<{ id: string }>(
          `SELECT id FROM managers WHERE id = ANY($1::uuid[]) AND role = 'manager'`,
          [unique],
        )
      : []
  const ids = valid.map((r) => r.id)

  await withTransaction(async (db) => {
    await db.query(
      `UPDATE managers SET traffic_source_id = NULL
        WHERE traffic_source_id = $1`,
      [sourceId],
    )
    if (ids.length > 0) {
      await db.query(
        `UPDATE managers SET traffic_source_id = $1
          WHERE id = ANY($2::uuid[]) AND role = 'manager'`,
        [sourceId, ids],
      )
    }
  })
}

/* ------------------------ Статистика и лиды -------------------------- */

export interface SourceStats {
  sourceId: string
  /** Всего лидов за всё время. */
  total: number
  /** Лидов за сегодня (МСК). */
  todayTotal: number
  /** Из них в дневном окне источника. */
  todayDay: number
  /** Из них «долёты» (вне дневного окна). */
  todayNight: number
}

/**
 * Статистика лидов по источникам одним запросом. «День»/«долёты»
 * определяются минутой первого обращения (created_at) в МСК против окна
 * КОНКРЕТНОГО источника — правило наследуется всеми его менеджерами.
 */
export async function getSourceStats(
  sourceIds: string[],
): Promise<Map<string, SourceStats>> {
  const out = new Map<string, SourceStats>()
  if (sourceIds.length === 0) return out
  const rows = await query<{
    source_id: string
    total: number
    today_total: number
    today_day: number
  }>(
    `SELECT ts.id AS source_id,
            COUNT(lc.id)::int AS total,
            COUNT(lc.id) FILTER (
              WHERE (lc.created_at AT TIME ZONE 'Europe/Moscow')::date
                    = (now() AT TIME ZONE 'Europe/Moscow')::date
            )::int AS today_total,
            COUNT(lc.id) FILTER (
              WHERE (lc.created_at AT TIME ZONE 'Europe/Moscow')::date
                    = (now() AT TIME ZONE 'Europe/Moscow')::date
                AND (EXTRACT(HOUR FROM (lc.created_at AT TIME ZONE 'Europe/Moscow')) * 60
                     + EXTRACT(MINUTE FROM (lc.created_at AT TIME ZONE 'Europe/Moscow')))
                    >= ts.day_start
                AND (EXTRACT(HOUR FROM (lc.created_at AT TIME ZONE 'Europe/Moscow')) * 60
                     + EXTRACT(MINUTE FROM (lc.created_at AT TIME ZONE 'Europe/Moscow')))
                    < ts.day_end
            )::int AS today_day
       FROM traffic_sources ts
       LEFT JOIN lead_cards lc
         ON lc.traffic_source_id = ts.id AND lc.deleted_at IS NULL
      WHERE ts.id = ANY($1::uuid[])
      GROUP BY ts.id`,
    [sourceIds],
  )
  for (const r of rows) {
    out.set(r.source_id, {
      sourceId: r.source_id,
      total: r.total,
      todayTotal: r.today_total,
      todayDay: r.today_day,
      todayNight: r.today_total - r.today_day,
    })
  }
  return out
}

/**
 * Лиды источников байера (read-only список раздела /buyer). Скоуп СТРОГО
 * по buyer_id источника — байер видит только свой трафик, включая архив
 * (атрибуция для него важнее статуса воронки).
 */
export async function listLeadCardsForBuyer(
  buyerId: string,
): Promise<LeadCard[]> {
  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.deleted_at IS NULL
        AND lc.traffic_source_id IN (
          SELECT id FROM traffic_sources WHERE buyer_id = $1
        )
      ORDER BY lc.created_at DESC`,
    [buyerId],
  )
  return rows.map(toLeadCard)
}
