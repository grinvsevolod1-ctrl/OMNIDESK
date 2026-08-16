/**
 * Канонический слой данных «Источника» — ЕДИНОЙ сущности проекта.
 *
 * Источник = finance_resources (он же «ресурс» в Учёте, он же «группа
 * источников» в старом Обзоре). Каналы привязаны через source_channels
 * (канал ∈ максимум одному источнику). Этот модуль — единственная точка
 * входа для нового «Обзора»: карточки со статистикой, детали (трафик +
 * воронка лидов + деньги) и CRUD.
 *
 * CRUD реэкспортируется из analytics-groups (те же finance_resources), чтобы
 * у сущности осталась одна реализация, а 12+ существующих потребителей
 * analytics-groups продолжали работать без изменений.
 */
import { cachedAnalytics } from '../analytics-cache'
import { query } from '../db'
import type { ChannelType } from '../types'
import {
  createSourceGroup,
  deleteSourceGroup,
  getGroupAnalytics,
  listSourceGroups,
  updateSourceGroup,
  type GroupAnalytics,
  type SourceGroup,
  type SourceGroupChannel,
} from './analytics-groups'

/* ------------------------------- CRUD ----------------------------------- */
// Единая терминология: «источник». Старые имена остаются в analytics-groups.

export type Source = SourceGroup
export type SourceChannel = SourceGroupChannel

export const listSources = listSourceGroups
export const createSource = createSourceGroup
export const updateSource = updateSourceGroup
export const deleteSource = deleteSourceGroup

/** Все панельные каналы (личные telegram-аккаунты владельца исключены). */
export async function listPanelChannels(): Promise<
  { id: string; name: string; type: ChannelType }[]
> {
  return query<{ id: string; name: string; type: ChannelType }>(
    `SELECT id, name, type FROM channels
      WHERE type <> 'telegram_personal'
      ORDER BY type ASC, name ASC`,
  )
}

/**
 * Привязка ОДНОГО канала к источнику (или отвязка при null) — для селекта
 * «Источник» в настройках канала. Канал принадлежит максимум одному
 * источнику: upsert по channel_id перетягивает его из прежнего источника.
 */
export async function assignChannelSource(
  channelId: string,
  sourceId: string | null,
): Promise<void> {
  if (sourceId === null) {
    await query(`DELETE FROM source_channels WHERE channel_id = $1`, [
      channelId,
    ])
    return
  }
  await query(
    `INSERT INTO source_channels (resource_id, channel_id)
     VALUES ($1, $2)
     ON CONFLICT (channel_id) DO UPDATE SET resource_id = EXCLUDED.resource_id`,
    [sourceId, channelId],
  )
}

/* --------------------------- Карточки обзора ----------------------------- */

export interface SourceCardStats {
  /** Написало людей за период (уникальные диалоги с входящими). */
  people: number
  /** Из них передано человеку / ликвид / передано дальше (текущий статус). */
  handoff: number
  liquid: number
  transferred: number
  /** Финансы за период (в валюте источника, cancelled не считаются). */
  income: number
  expense: number
  /** Люди по дням за период (плотный ряд, старые -> новые), для спарклайна. */
  spark: number[]
}

export interface SourceOverviewItem {
  id: string
  name: string
  currency: string
  createdAt: string
  channels: { id: string; name: string; type: ChannelType }[]
  stats: SourceCardStats
}

export interface SourcesOverview {
  from: string
  to: string
  items: SourceOverviewItem[]
  /** Каналы, не привязанные ни к одному источнику (системная карточка). */
  unassigned: {
    channels: { id: string; name: string; type: ChannelType }[]
    stats: SourceCardStats
  } | null
}

function emptyStats(sparkDays: number): SourceCardStats {
  return {
    people: 0,
    handoff: 0,
    liquid: 0,
    transferred: 0,
    income: 0,
    expense: 0,
    spark: Array.from({ length: sparkDays }, () => 0),
  }
}

/** Число дней (локальных суток) внутри [from, to), максимум 92. */
function dayCount(fromISO: string, toISO: string): number {
  const ms = new Date(toISO).getTime() - new Date(fromISO).getTime()
  return Math.max(1, Math.min(92, Math.ceil(ms / 86_400_000)))
}

/**
 * Статистика всех источников для сетки карточек Обзора.
 *
 * Ровно 4 SQL-запроса на весь экран (без N+1, сколько бы источников ни было):
 *   1. список источников + каналы;
 *   2. трафик и статусы диалогов по источникам;
 *   3. спарклайны (люди по дням) по источникам;
 *   4. финансовые суммы по источникам.
 * Каналы без источника сворачиваются в системную карточку «Без источника».
 */
async function getSourcesOverviewUncached(
  fromISO: string,
  toISO: string,
  tzOffsetMinutes = 0,
): Promise<SourcesOverview> {
  const off = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0
  const sparkDays = dayCount(fromISO, toISO)
  const localDayExpr = `to_char((f.first_at AT TIME ZONE 'UTC') - make_interval(mins => $3::int), 'YYYY-MM-DD')`

  // Первый входящий каждого диалога — считаем человека один раз, в день
  // первого контакта (та же семантика, что в KPI дашборда).
  const FIRST_CONTACT = `
    SELECT c.id, c.channel_id, c.status,
           MIN(m.created_at) FILTER (WHERE m.direction = 'in') AS first_at
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
     GROUP BY c.id, c.channel_id, c.status`

  const [sources, trafficRows, sparkRows, financeRows] = await Promise.all([
    listSourceGroups(),
    query<{
      resource_id: string | null
      people: string
      handoff: string
      liquid: string
      transferred: string
    }>(
      `SELECT sc.resource_id,
              count(*)::int AS people,
              count(*) FILTER (WHERE f.status IN ('handoff', 'liquid', 'transferred'))::int AS handoff,
              count(*) FILTER (WHERE f.status IN ('liquid', 'transferred'))::int AS liquid,
              count(*) FILTER (WHERE f.status = 'transferred')::int AS transferred
         FROM (${FIRST_CONTACT}) f
         LEFT JOIN source_channels sc ON sc.channel_id = f.channel_id
        WHERE f.first_at >= $1 AND f.first_at < $2
        GROUP BY sc.resource_id`,
      [fromISO, toISO],
    ),
    query<{ resource_id: string | null; d: string; people: string }>(
      `SELECT sc.resource_id, ${localDayExpr} AS d, count(*)::int AS people
         FROM (${FIRST_CONTACT}) f
         LEFT JOIN source_channels sc ON sc.channel_id = f.channel_id
        WHERE f.first_at >= $1 AND f.first_at < $2
        GROUP BY sc.resource_id, 2`,
      [fromISO, toISO, off],
    ),
    query<{ resource_id: string; income: string; expense: string }>(
      `SELECT e.resource_id,
              COALESCE(sum(e.amount) FILTER (WHERE e.type = 'income'), 0) AS income,
              COALESCE(sum(e.amount) FILTER (WHERE e.type = 'expense'), 0) AS expense
         FROM finance_entries e
        WHERE e.status <> 'cancelled'
          AND e.entry_date >= ($1::timestamptz)::date
          AND e.entry_date < ($2::timestamptz)::date + 1
        GROUP BY e.resource_id`,
      [fromISO, toISO],
    ),
  ])

  // Ось дней в локальном календаре админа (как в getGroupAnalytics).
  const dayKeys: string[] = []
  {
    const startShift = new Date(new Date(fromISO).getTime() - off * 60000)
    let cursor = new Date(
      Date.UTC(
        startShift.getUTCFullYear(),
        startShift.getUTCMonth(),
        startShift.getUTCDate(),
      ),
    )
    for (let i = 0; i < sparkDays; i++) {
      dayKeys.push(cursor.toISOString().slice(0, 10))
      cursor = new Date(cursor)
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }

  const statsByResource = new Map<string, SourceCardStats>()
  const statFor = (rid: string): SourceCardStats => {
    let s = statsByResource.get(rid)
    if (!s) {
      s = emptyStats(dayKeys.length)
      statsByResource.set(rid, s)
    }
    return s
  }
  const UNASSIGNED = '__unassigned__'

  for (const r of trafficRows) {
    const s = statFor(r.resource_id ?? UNASSIGNED)
    s.people = Number(r.people)
    s.handoff = Number(r.handoff)
    s.liquid = Number(r.liquid)
    s.transferred = Number(r.transferred)
  }
  for (const r of sparkRows) {
    const s = statFor(r.resource_id ?? UNASSIGNED)
    const idx = dayKeys.indexOf(r.d)
    if (idx >= 0) s.spark[idx] = Number(r.people)
  }
  for (const r of financeRows) {
    const s = statFor(r.resource_id)
    s.income = Number(r.income)
    s.expense = Number(r.expense)
  }

  const items: SourceOverviewItem[] = sources.map((g) => ({
    id: g.id,
    name: g.name,
    currency: 'USDT',
    createdAt: g.createdAt,
    channels: g.channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    stats: statsByResource.get(g.id) ?? emptyStats(dayKeys.length),
  }))

  // Валюта источников: один лёгкий запрос вместо расширения listSourceGroups.
  const currencyRows = await query<{ id: string; currency: string }>(
    `SELECT id, currency FROM finance_resources WHERE archived = false`,
  )
  const currencyById = new Map(currencyRows.map((r) => [r.id, r.currency]))
  for (const it of items) it.currency = currencyById.get(it.id) ?? 'USDT'

  // Каналы без источника — только реальные панельные каналы.
  const unassignedChannels = await query<{
    id: string
    name: string
    type: ChannelType
  }>(
    `SELECT ch.id, ch.name, ch.type
       FROM channels ch
       LEFT JOIN source_channels sc ON sc.channel_id = ch.id
      WHERE sc.channel_id IS NULL
        AND ch.type <> 'telegram_personal'
      ORDER BY ch.type ASC, ch.name ASC`,
  )
  const unassignedStats = statsByResource.get(UNASSIGNED)
  const unassigned =
    unassignedChannels.length > 0
      ? {
          channels: unassignedChannels,
          stats: unassignedStats ?? emptyStats(dayKeys.length),
        }
      : null

  return { from: fromISO, to: toISO, items, unassigned }
}

/** Статистика источников для сетки Обзора (кэш 60с). */
export const getSourcesOverview = cachedAnalytics(getSourcesOverviewUncached, [
  'getSourcesOverview',
])

/* --------------------------- Детали источника ---------------------------- */

export interface SourceFunnel {
  people: number
  handoff: number
  liquid: number
  transferred: number
}

export interface SourceFinanceSummary {
  currency: string
  income: number
  expense: number
  /** Баланс за всё время (не только за период). */
  balanceAllTime: number
}

export interface SourceDetail {
  id: string
  name: string
  from: string
  to: string
  /** Трафик: люди/сообщения по каналам, типам, дням (и часам для 1 дня). */
  traffic: GroupAnalytics
  funnel: SourceFunnel
  finance: SourceFinanceSummary
  channels: { id: string; name: string; type: ChannelType }[]
}

/**
 * Полные детали источника для нижней панели Обзора: переиспользует
 * getGroupAnalytics (трафик) и добавляет воронку статусов + финансовую сводку.
 */
async function getSourceDetailUncached(
  sourceId: string,
  fromISO: string,
  toISO: string,
  tzOffsetMinutes = 0,
): Promise<SourceDetail | null> {
  const meta = await query<{ id: string; name: string; currency: string }>(
    `SELECT id, name, currency FROM finance_resources WHERE id = $1 AND archived = false`,
    [sourceId],
  )
  if (meta.length === 0) return null

  const [traffic, funnelRows, financeRows, channelRows] = await Promise.all([
    getGroupAnalytics(sourceId, fromISO, toISO, tzOffsetMinutes),
    query<{
      people: string
      handoff: string
      liquid: string
      transferred: string
    }>(
      `SELECT count(*)::int AS people,
              count(*) FILTER (WHERE f.status IN ('handoff', 'liquid', 'transferred'))::int AS handoff,
              count(*) FILTER (WHERE f.status IN ('liquid', 'transferred'))::int AS liquid,
              count(*) FILTER (WHERE f.status = 'transferred')::int AS transferred
         FROM (
           SELECT c.id, c.status,
                  MIN(m.created_at) FILTER (WHERE m.direction = 'in') AS first_at
             FROM source_channels sc
             JOIN conversations c ON c.channel_id = sc.channel_id
             JOIN messages m ON m.conversation_id = c.id
            WHERE sc.resource_id = $1
            GROUP BY c.id, c.status
         ) f
        WHERE f.first_at >= $2 AND f.first_at < $3`,
      [sourceId, fromISO, toISO],
    ),
    query<{
      income: string
      expense: string
      income_all: string
      expense_all: string
    }>(
      `SELECT COALESCE(sum(e.amount) FILTER (
                WHERE e.type = 'income'
                  AND e.entry_date >= ($2::timestamptz)::date
                  AND e.entry_date < ($3::timestamptz)::date + 1), 0) AS income,
              COALESCE(sum(e.amount) FILTER (
                WHERE e.type = 'expense'
                  AND e.entry_date >= ($2::timestamptz)::date
                  AND e.entry_date < ($3::timestamptz)::date + 1), 0) AS expense,
              COALESCE(sum(e.amount) FILTER (WHERE e.type = 'income'), 0) AS income_all,
              COALESCE(sum(e.amount) FILTER (WHERE e.type = 'expense'), 0) AS expense_all
         FROM finance_entries e
        WHERE e.resource_id = $1 AND e.status <> 'cancelled'`,
      [sourceId, fromISO, toISO],
    ),
    query<{ id: string; name: string; type: ChannelType }>(
      `SELECT ch.id, ch.name, ch.type
         FROM source_channels sc
         JOIN channels ch ON ch.id = sc.channel_id
        WHERE sc.resource_id = $1
        ORDER BY ch.type ASC, ch.name ASC`,
      [sourceId],
    ),
  ])

  const fin = financeRows[0]
  return {
    id: meta[0].id,
    name: meta[0].name,
    from: fromISO,
    to: toISO,
    traffic,
    funnel: {
      people: Number(funnelRows[0]?.people ?? 0),
      handoff: Number(funnelRows[0]?.handoff ?? 0),
      liquid: Number(funnelRows[0]?.liquid ?? 0),
      transferred: Number(funnelRows[0]?.transferred ?? 0),
    },
    finance: {
      currency: meta[0].currency,
      income: Number(fin?.income ?? 0),
      expense: Number(fin?.expense ?? 0),
      balanceAllTime: Number(fin?.income_all ?? 0) - Number(fin?.expense_all ?? 0),
    },
    channels: channelRows,
  }
}

/** Детали источника (кэш 60с). */
export const getSourceDetail = cachedAnalytics(getSourceDetailUncached, [
  'getSourceDetail',
])
