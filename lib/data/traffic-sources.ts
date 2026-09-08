/**
 * Источники трафика (миграция 145): каждый источник ведёт один медиабайер
 * (role = 'buyer'), к источнику подключаются менеджеры продаж
 * (managers.traffic_source_id), лиды фиксируют источник на момент обращения
 * (lead_cards.traffic_source_id — денормализация сознательная).
 *
 * Источник работает всегда — окон «дня»/«долётов» больше нет. Статистика
 * источника — написавшие (лиды) и переданные куратору, всего и за сегодня (МСК).
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
  /** Ключ платформы из каталога ('yandex_direct' | 'custom' | ...). */
  platformKey: string
  /** Базовая валюта учёта источника (в ней показывается баланс). */
  currency: string
  /** Логин / номер кабинета / ссылка на кабинет площадки. */
  externalAccount: string
  /** Байер завершил первичную настройку источника (мастер каталога). */
  setupCompleted: boolean
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
  platform_key: string
  currency: string
  external_account: string
  setup_completed: boolean
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
    platformKey: row.platform_key,
    currency: row.currency,
    externalAccount: row.external_account,
    setupCompleted: row.setup_completed,
    notes: row.notes,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
    managerCount: row.manager_count,
    leadCount: row.lead_count,
  }
}

const SOURCE_SELECT = `
  ts.id, ts.name, ts.buyer_id, b.name AS buyer_name,
  ts.platform_key, ts.currency, ts.external_account, ts.setup_completed,
  ts.notes, ts.is_active, ts.created_at,
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

/** Id байера-владельца источника (для скоуп-гейтов финансов). */
export async function getBuyerIdForSource(
  sourceId: string,
): Promise<string | null> {
  const rows = await query<{ buyer_id: string | null }>(
    `SELECT buyer_id FROM traffic_sources WHERE id = $1 LIMIT 1`,
    [sourceId],
  )
  return rows[0]?.buyer_id ?? null
}

export async function createTrafficSource(input: {
  name: string
  buyerId: string | null
  notes?: string | null
}): Promise<TrafficSource> {
  const name = input.name.trim()
  if (!name) throw new Error('Укажите название источника.')
  const id = randomUUID()
  await query(
    `INSERT INTO traffic_sources (id, name, buyer_id, notes)
     VALUES ($1, $2, $3, $4)`,
    [id, name, input.buyerId, input.notes?.trim() || null],
  )
  const created = await getTrafficSourceById(id)
  if (!created) throw new Error('Source create failed')
  return created
}

/**
 * Создание источника САМИМ байером из каталога (раздел /buyer). В отличие от
 * админского createTrafficSource, владелец фиксируется на текущего байера,
 * заполняются поля платформы/валюты/кабинета и сразу помечается setup_completed.
 * Единый путь создания источника в новой модели (single source of truth).
 */
export async function createTrafficSourceForBuyer(input: {
  buyerId: string
  name: string
  platformKey: string
  currency: string
  externalAccount?: string
  notes?: string | null
  config?: Record<string, unknown>
}): Promise<TrafficSource> {
  const name = input.name.trim()
  if (!name) throw new Error('Укажите название источника.')
  const platformKey = input.platformKey.trim() || 'custom'
  const currency = input.currency.trim().toUpperCase() || 'RUB'
  const id = randomUUID()
  await query(
    `INSERT INTO traffic_sources
       (id, name, buyer_id, platform_key, currency, external_account,
        config, setup_completed, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, $8)`,
    [
      id,
      name,
      input.buyerId,
      platformKey,
      currency,
      input.externalAccount?.trim() || '',
      JSON.stringify(input.config ?? {}),
      input.notes?.trim() || null,
    ],
  )
  const created = await getTrafficSourceById(id)
  if (!created) throw new Error('Source create failed')
  return created
}

/**
 * Обновление настроек источника байером (название, кабинет, заметки).
 * Валюту/платформу после создания не меняем — от них зависят проведённые
 * депозиты и траты (изменение исказило бы историю баланса).
 */
export async function updateTrafficSourceByBuyer(input: {
  id: string
  buyerId: string
  name: string
  externalAccount?: string
  notes?: string | null
}): Promise<TrafficSource> {
  const name = input.name.trim()
  if (!name) throw new Error('Укажите название источника.')
  const res = await query<{ id: string }>(
    `UPDATE traffic_sources
        SET name = $3, external_account = $4, notes = $5, updated_at = now()
      WHERE id = $1 AND buyer_id = $2
      RETURNING id`,
    [
      input.id,
      input.buyerId,
      name,
      input.externalAccount?.trim() || '',
      input.notes?.trim() || null,
    ],
  )
  if (res.length === 0) {
    throw new Error('Источник не найден или принадлежит другому байеру.')
  }
  const updated = await getTrafficSourceById(input.id)
  if (!updated) throw new Error('Источник не найден.')
  return updated
}

/** Владелец-байер источника (для скоуп-гейтов server actions). */
export async function getSourceOwnerId(
  sourceId: string,
): Promise<string | null> {
  const rows = await query<{ buyer_id: string | null }>(
    `SELECT buyer_id FROM traffic_sources WHERE id = $1 LIMIT 1`,
    [sourceId],
  )
  return rows[0]?.buyer_id ?? null
}

export async function updateTrafficSource(input: {
  id: string
  name: string
  buyerId: string | null
  notes?: string | null
  isActive: boolean
}): Promise<TrafficSource> {
  const name = input.name.trim()
  if (!name) throw new Error('Укажите название источника.')
  await query(
    `UPDATE traffic_sources
        SET name = $2, buyer_id = $3, notes = $4, is_active = $5,
            updated_at = now()
      WHERE id = $1`,
    [
      input.id,
      name,
      input.buyerId,
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
  /** Всего написавших (лидов) за всё время. */
  total: number
  /** Написавших сегодня (МСК). */
  todayTotal: number
  /** Всего передано куратору. */
  transferredTotal: number
  /** Передано куратору сегодня (МСК). */
  transferredToday: number
}

/**
 * Статистика лидов по источникам одним запросом: сколько всего написали и
 * написали сегодня (по created_at в МСК), сколько передано куратору всего и
 * сегодня (по transferred_at в МСК). Окон «дня»/«долётов» больше нет —
 * источник работает круглосуточно.
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
    transferred_total: number
    transferred_today: number
  }>(
    `SELECT ts.id AS source_id,
            COUNT(lc.id)::int AS total,
            COUNT(lc.id) FILTER (
              WHERE (lc.created_at AT TIME ZONE 'Europe/Moscow')::date
                    = (now() AT TIME ZONE 'Europe/Moscow')::date
            )::int AS today_total,
            COUNT(lc.id) FILTER (
              WHERE lc.curator_id IS NOT NULL
            )::int AS transferred_total,
            COUNT(lc.id) FILTER (
              WHERE lc.curator_id IS NOT NULL
                AND lc.transferred_at IS NOT NULL
                AND (lc.transferred_at AT TIME ZONE 'Europe/Moscow')::date
                    = (now() AT TIME ZONE 'Europe/Moscow')::date
            )::int AS transferred_today
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
      transferredTotal: r.transferred_total,
      transferredToday: r.transferred_today,
    })
  }
  return out
}

/* --------------------- Отчёт по написавшим/переданным ------------------ */

export interface SourceTodayReport {
  /** Лиды, написавшие сегодня (МСК), новые сверху. */
  wroteToday: LeadCard[]
  /** Лиды, переданные куратору сегодня (МСК), новые сверху. */
  transferredToday: LeadCard[]
  /** Всего написавших за всё время. */
  totalWrote: number
  /** Всего переданных куратору. */
  totalTransferred: number
}

/**
 * Отчёт источника за сегодня для «Обзора»: списки написавших и переданных
 * лидов (для drill-down в модалке) плюс итоги за всё время. Скоуп источника
 * проверяет вызывающий server action.
 */
export async function getSourceTodayReport(
  sourceId: string,
): Promise<SourceTodayReport> {
  const leadJoins = `
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.traffic_source_id = $1 AND lc.deleted_at IS NULL`
  const [wrote, transferred, totals] = await Promise.all([
    query<LeadCardRow>(
      `SELECT ${CARD_SELECT} ${leadJoins}
        AND (lc.created_at AT TIME ZONE 'Europe/Moscow')::date
            = (now() AT TIME ZONE 'Europe/Moscow')::date
      ORDER BY lc.created_at DESC`,
      [sourceId],
    ),
    query<LeadCardRow>(
      `SELECT ${CARD_SELECT} ${leadJoins}
        AND lc.curator_id IS NOT NULL
        AND lc.transferred_at IS NOT NULL
        AND (lc.transferred_at AT TIME ZONE 'Europe/Moscow')::date
            = (now() AT TIME ZONE 'Europe/Moscow')::date
      ORDER BY lc.transferred_at DESC`,
      [sourceId],
    ),
    query<{ total_wrote: number; total_transferred: number }>(
      `SELECT COUNT(*)::int AS total_wrote,
              COUNT(*) FILTER (WHERE curator_id IS NOT NULL)::int
                AS total_transferred
         FROM lead_cards
        WHERE traffic_source_id = $1 AND deleted_at IS NULL`,
      [sourceId],
    ),
  ])
  return {
    wroteToday: wrote.map(toLeadCard),
    transferredToday: transferred.map(toLeadCard),
    totalWrote: totals[0]?.total_wrote ?? 0,
    totalTransferred: totals[0]?.total_transferred ?? 0,
  }
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
