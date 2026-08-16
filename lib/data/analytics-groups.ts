/**
 * Source-group analytics, extracted from lib/data/analytics.ts and re-exported
 * from it for backward compatibility. Covers source-group CRUD + channel
 * assignment, per-source real lead counts, source-group rollups and per-manager
 * activity analytics (all time-cached via cachedAnalytics).
 */
import { cachedAnalytics } from '../analytics-cache'
import { query } from '../db'
import type { ChannelStatus, ChannelType, PanelChannelType } from '../types'

/* --------------------------- Source groups ----------------------------- */
// A "source" (исторически "source group") — это ЕДИНАЯ сущность проекта: она же
// finance_resources в Учёте. К ней привязаны каналы (Telegram / WhatsApp +
// виджет онлайн-чата) через source_channels — это используется отчётом «Обзор».
// После унификации source_groups больше не читаются: канонический список
// источников берётся из finance_resources, а членство каналов — из
// source_channels. Функции сохраняют прежние имена/сигнатуры, чтобы вызывающий
// код (app/actions/groups.ts) не менялся.

export interface SourceGroupChannel {
  id: string
  type: ChannelType
  name: string
  detail: string
  status: ChannelStatus
}

export interface SourceGroup {
  id: string
  name: string
  createdAt: string
  channels: SourceGroupChannel[]
}

/** All sources (finance resources) with their member channels. */
export async function listSourceGroups(): Promise<SourceGroup[]> {
  const rows = await query<{
    id: string
    name: string
    created_at: string | Date
    channel_id: string | null
    channel_type: ChannelType | null
    channel_name: string | null
    channel_detail: string | null
    channel_status: ChannelStatus | null
  }>(
    `SELECT r.id, r.name, r.created_at,
            ch.id AS channel_id, ch.type AS channel_type, ch.name AS channel_name,
            ch.detail AS channel_detail, ch.status AS channel_status
       FROM finance_resources r
       LEFT JOIN source_channels sc ON sc.resource_id = r.id
       LEFT JOIN channels ch ON ch.id = sc.channel_id
      WHERE r.archived = false
      ORDER BY r.created_at ASC, ch.type ASC, ch.name ASC`,
  )

  const map = new Map<string, SourceGroup>()
  for (const r of rows) {
    let g = map.get(r.id)
    if (!g) {
      g = {
        id: r.id,
        name: r.name,
        createdAt: new Date(r.created_at).toISOString(),
        channels: [],
      }
      map.set(r.id, g)
    }
    if (r.channel_id && r.channel_type) {
      g.channels.push({
        id: r.channel_id,
        type: r.channel_type,
        name: r.channel_name ?? 'Канал',
        detail: r.channel_detail ?? '',
        status: r.channel_status ?? 'pending',
      })
    }
  }
  return [...map.values()]
}

/** Replace a source's channel membership with the given channel ids. */
async function setGroupChannels(
  resourceId: string,
  channelIds: string[],
): Promise<void> {
  await query(`DELETE FROM source_channels WHERE resource_id = $1`, [resourceId])
  const ids = [...new Set(channelIds)].filter(Boolean)
  if (ids.length === 0) return
  // Single multi-row upsert via unnest instead of one INSERT per channel. A
  // channel belongs to at most one source, so ON CONFLICT (channel_id) steals it
  // from any other source — the latest assignment wins instead of erroring on
  // the UNIQUE constraint.
  await query(
    `INSERT INTO source_channels (resource_id, channel_id)
     SELECT $1, cid FROM unnest($2::uuid[]) AS t(cid)
     ON CONFLICT (channel_id) DO UPDATE SET resource_id = EXCLUDED.resource_id`,
    [resourceId, ids],
  )
}

export async function createSourceGroup(
  name: string,
  channelIds: string[],
): Promise<SourceGroup> {
  // Creating a source in «Обзор» creates the SAME finance_resource that «Учёт»
  // uses — one entity, visible in both places. Currency is unified to USD
  // (the canonical default: «Учёт» forces USD and the DB default is USD too).
  const rows = await query<{ id: string }>(
    `INSERT INTO finance_resources (name, description, currency)
     VALUES ($1, '', 'USD') RETURNING id`,
    [name.trim() || 'Источник'],
  )
  const id = rows[0].id
  await setGroupChannels(id, channelIds)
  const all = await listSourceGroups()
  return all.find((g) => g.id === id) as SourceGroup
}

export async function updateSourceGroup(
  id: string,
  input: { name?: string; channelIds?: string[] },
): Promise<void> {
  if (typeof input.name === 'string') {
    await query(`UPDATE finance_resources SET name = $2 WHERE id = $1`, [
      id,
      input.name.trim() || 'Источник',
    ])
  }
  if (input.channelIds) {
    await setGroupChannels(id, input.channelIds)
  }
}

export async function deleteSourceGroup(id: string): Promise<void> {
  // Deleting a source now removes the whole entity — finance data included —
  // via ON DELETE CASCADE. The UI warns the operator before calling this.
  await query(`DELETE FROM finance_resources WHERE id = $1`, [id])
}

/* ----------------------- Real lead counts per source -------------------- */

/**
 * Real inbound-lead counts per source (finance resource), derived from the
 * conversations on its attached channels — the SAME definition «Обзор» uses
 * ("distinct people who wrote in"). This replaces the old fake per-cabinet lead
 * numbers in «Учёт». Returns a map of resourceId → distinct inbound people.
 * Pass a date range to scope it; omit for all-time.
 */
async function getResourceLeadCountsUncached(
  resourceIds: string[],
  range?: { fromISO: string; toISO: string },
): Promise<Record<string, number>> {
  const ids = [...new Set(resourceIds)].filter(Boolean)
  if (ids.length === 0) return {}

  const params: unknown[] = [ids]
  let dateFilter = ''
  if (range) {
    params.push(range.fromISO, range.toISO)
    dateFilter = `AND m.created_at >= $2 AND m.created_at < $3`
  }

  const rows = await query<{ resource_id: string; people: string }>(
    `SELECT sc.resource_id,
            count(DISTINCT c.id)::int AS people
       FROM source_channels sc
       JOIN conversations c ON c.channel_id = sc.channel_id
       JOIN messages m ON m.conversation_id = c.id
            AND m.direction = 'in' ${dateFilter}
      WHERE sc.resource_id = ANY($1::uuid[])
      GROUP BY sc.resource_id`,
    params,
  )

  const out: Record<string, number> = {}
  for (const id of ids) out[id] = 0
  for (const r of rows) out[r.resource_id] = Number(r.people)
  return out
}

/** Distinct-people counts per resource for the finance dashboard (time-cached). */
export const getResourceLeadCounts = cachedAnalytics(
  getResourceLeadCountsUncached,
  ['getResourceLeadCounts'],
)

/* ----------------------- Source group analytics ------------------------ */

export interface GroupChannelStat {
  channelId: string
  name: string
  type: ChannelType
  /** Distinct people (conversations) who wrote in within the range. */
  people: number
  /** Inbound messages received within the range. */
  messages: number
}

export interface GroupAnalytics {
  groupId: string
  groupName: string
  from: string
  to: string
  /** Distinct people (conversations) who wrote in across the whole group. */
  totalPeople: number
  totalMessages: number
  byType: Record<PanelChannelType, { people: number; messages: number }>
  byChannel: GroupChannelStat[]
  /** People per day, split by messenger type (oldest first, dense). */
  byDay: {
    date: string
    telegram: number
    whatsapp: number
    livechat: number
    max: number
    vk: number
  }[]
  /**
   * People per hour (0–23) for a single-day range, split by messenger type.
   * Only populated when the range covers exactly one local day (e.g. "today")
   * — used to draw the intraday running line. Null for multi-day ranges.
   */
  byHour:
    | {
      hour: number
      telegram: number
      whatsapp: number
      livechat: number
      max: number
      vk: number
    }[]
    | null
}

// PanelChannelType: personal-аккаунты god-панели не привязываются к
// источникам и не попадают в отчёты по группам.
function emptyTypeStats(): Record<PanelChannelType, { people: number; messages: number }> {
  return {
    telegram: { people: 0, messages: 0 },
    whatsapp: { people: 0, messages: 0 },
    livechat: { people: 0, messages: 0 },
    max: { people: 0, messages: 0 },
    vk: { people: 0, messages: 0 },
  }
}

/**
 * Detailed "who wrote in" report for one source group over a date range.
 * A "person" is a distinct conversation (one contact on one channel) that has
 * at least one inbound message inside [from, to). Counts are broken down per
 * channel, per messenger type, and per day.
 */
async function getGroupAnalyticsUncached(
  groupId: string,
  fromISO: string,
  toISO: string,
  // Client timezone offset, in the JS `Date.getTimezoneOffset()` convention
  // (minutes; MSK = -180). Day buckets are computed in the visitor admin's
  // local calendar so "today" lines up with their clock, not the server's UTC.
  tzOffsetMinutes = 0,
): Promise<GroupAnalytics> {
  const groupRows = await query<{ name: string }>(
    `SELECT name FROM finance_resources WHERE id = $1`,
    [groupId],
  )
  const groupName = groupRows[0]?.name ?? 'Источник'
  const off = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0
  const params = [groupId, fromISO, toISO]
  const dayParams = [...params, off]
  // local wall-clock = UTC wall-clock - offsetMinutes (MSK: -(-180) = +180).
  const localDayExpr = `to_char((m.created_at AT TIME ZONE 'UTC') - make_interval(mins => $4::int), 'YYYY-MM-DD')`

  const [totalRows, channelRows, dayRows] = await Promise.all([
    query<{ people: string; messages: string }>(
      `SELECT count(DISTINCT c.id)::int AS people, count(m.id)::int AS messages
         FROM source_channels sgc
         JOIN conversations c ON c.channel_id = sgc.channel_id
         JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.resource_id = $1`,
      params,
    ),
    query<{
      channel_id: string
      name: string
      type: ChannelType
      people: string
      messages: string
    }>(
      `SELECT ch.id AS channel_id, ch.name, ch.type,
              count(DISTINCT c.id) FILTER (WHERE m.id IS NOT NULL)::int AS people,
              count(m.id)::int AS messages
         FROM source_channels sgc
         JOIN channels ch ON ch.id = sgc.channel_id
         LEFT JOIN conversations c ON c.channel_id = ch.id
         LEFT JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.resource_id = $1
        GROUP BY ch.id, ch.name, ch.type
        ORDER BY people DESC, ch.name ASC`,
      params,
    ),
    query<{ d: string; type: ChannelType; people: string }>(
      `SELECT ${localDayExpr} AS d, ch.type,
              count(DISTINCT c.id)::int AS people
         FROM source_channels sgc
         JOIN channels ch ON ch.id = sgc.channel_id
         JOIN conversations c ON c.channel_id = ch.id
         JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.resource_id = $1
        GROUP BY 1, 2
        ORDER BY 1`,
      dayParams,
    ),
  ])

  const byChannel: GroupChannelStat[] = channelRows.map((r) => ({
    channelId: r.channel_id,
    name: r.name,
    type: r.type,
    people: Number(r.people),
    messages: Number(r.messages),
  }))

  const byType = emptyTypeStats()
  for (const c of byChannel) {
    // Guard against channel types outside the panel union (legacy/bad rows,
    // personal accounts): a direct byType[...] would be undefined and crash.
    const t = c.type as PanelChannelType
    if (!byType[t]) continue
    byType[t].people += c.people
    byType[t].messages += c.messages
  }

  // Dense per-day series across [from, to) so the chart has no gaps. `r.d` is
  // already a local 'YYYY-MM-DD' string (bucketed in the admin's timezone).
  const dayMap = new Map<string, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
  for (const r of dayRows) {
    const cur = dayMap.get(r.d) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
    // Пропускаем типы вне панельного набора (personal-аккаунты и legacy-мусор).
    if (!(r.type in cur)) continue
    cur[r.type as PanelChannelType] = Number(r.people)
    dayMap.set(r.d, cur)
  }
  // Build the axis in the same local calendar. We shift the UTC instants by the
  // offset and then iterate whole UTC days, so each key is the local day string.
  const byDay: GroupAnalytics['byDay'] = []
  const startShift = new Date(new Date(fromISO).getTime() - off * 60000)
  const endShift = new Date(new Date(toISO).getTime() - off * 60000)
  let cursor = new Date(
    Date.UTC(
      startShift.getUTCFullYear(),
      startShift.getUTCMonth(),
      startShift.getUTCDate(),
    ),
  )
  // Cap the series at 92 days to keep the response bounded for huge ranges.
  for (let i = 0; i < 92 && cursor < endShift; i++) {
    const key = cursor.toISOString().slice(0, 10)
    const v = dayMap.get(key) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
    byDay.push({ date: key, ...v })
    cursor = new Date(cursor)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  // For a single local day, also bucket people by hour so the UI can draw an
  // intraday running line (e.g. the "today" view).
  let byHour: GroupAnalytics['byHour'] = null
  if (byDay.length === 1) {
    // local hour = (utc - offset) hour-of-day.
    const localHourExpr = `EXTRACT(HOUR FROM (m.created_at AT TIME ZONE 'UTC') - make_interval(mins => $4::int))::int`
    const hourRows = await query<{ h: number; type: ChannelType; people: string }>(
      `SELECT ${localHourExpr} AS h, ch.type,
              count(DISTINCT c.id)::int AS people
         FROM source_channels sgc
         JOIN channels ch ON ch.id = sgc.channel_id
         JOIN conversations c ON c.channel_id = ch.id
         JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.resource_id = $1
        GROUP BY 1, 2`,
      dayParams,
    )
    const hourMap = new Map<number, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
    for (const r of hourRows) {
      const cur = hourMap.get(r.h) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
      // Пропускаем типы вне панельного набора (personal-аккаунты и legacy-мусор).
      if (!(r.type in cur)) continue
      cur[r.type as PanelChannelType] = Number(r.people)
      hourMap.set(r.h, cur)
    }
    byHour = []
    for (let h = 0; h < 24; h++) {
      const v = hourMap.get(h) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
      byHour.push({ hour: h, ...v })
    }
  }

  return {
    groupId,
    groupName,
    from: fromISO,
    to: toISO,
    totalPeople: Number(totalRows[0]?.people ?? 0),
    totalMessages: Number(totalRows[0]?.messages ?? 0),
    byType,
    byChannel,
    byDay,
    byHour,
  }
}

/** Source-group activity analytics (time-cached). */
export const getGroupAnalytics = cachedAnalytics(getGroupAnalyticsUncached, [
  'getGroupAnalytics',
])

export interface ManagerActivityAnalytics {
  from: string
  to: string
  totalPeople: number
  /** People per day, split by messenger type (oldest first, dense). */
  byDay: {
    date: string
    telegram: number
    whatsapp: number
    livechat: number
    max: number
    vk: number
  }[]
  /** People per hour for a single-day range, or null for multi-day ranges. */
  byHour:
    | {
      hour: number
      telegram: number
      whatsapp: number
      livechat: number
      max: number
      vk: number
    }[]
    | null
}

/**
 * Activity analytics for a single manager — distinct people who wrote in,
 * bucketed by day (and by hour for a single-day range), split by messenger
 * type. Mirrors getGroupAnalytics but scoped to the manager's own
 * conversations. Day/hour buckets use the manager's local calendar via
 * `tzOffsetMinutes` (JS `Date.getTimezoneOffset()` convention; MSK = -180).
 */
async function getManagerActivityAnalyticsUncached(
  managerId: string,
  fromISO: string,
  toISO: string,
  tzOffsetMinutes = 0,
): Promise<ManagerActivityAnalytics> {
  const off = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0
  const params = [managerId, fromISO, toISO]
  const dayParams = [...params, off]
  // Bucket by each lead's FIRST inbound message ("first contact"), so every lead
  // is counted exactly once — on the day they first wrote in — matching the
  // dashboard KPIs. A lead writing again on a later day is never re-counted.
  const localDayExpr = `to_char((f.first_at AT TIME ZONE 'UTC') - make_interval(mins => $4::int), 'YYYY-MM-DD')`
  const FIRST_CONTACT_CTE = `
    SELECT c.id, c.channel_id,
           MIN(m.created_at) FILTER (WHERE m.direction = 'in') AS first_at
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
     WHERE c.manager_id = $1
     GROUP BY c.id, c.channel_id`

  const [totalRows, dayRows] = await Promise.all([
    query<{ people: string }>(
      `SELECT count(*)::int AS people
         FROM (${FIRST_CONTACT_CTE}) f
        WHERE f.first_at >= $2 AND f.first_at < $3`,
      params,
    ),
    query<{ d: string; type: ChannelType; people: string }>(
      `SELECT ${localDayExpr} AS d, ch.type,
              count(*)::int AS people
         FROM (${FIRST_CONTACT_CTE}) f
         JOIN channels ch ON ch.id = f.channel_id
        WHERE f.first_at >= $2 AND f.first_at < $3
        GROUP BY 1, 2
        ORDER BY 1`,
      dayParams,
    ),
  ])

  const dayMap = new Map<string, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
  for (const r of dayRows) {
    const cur = dayMap.get(r.d) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
    // Пропускаем типы вне панельного набора (personal-аккаунты и legacy-мусор).
    if (!(r.type in cur)) continue
    cur[r.type as PanelChannelType] = Number(r.people)
    dayMap.set(r.d, cur)
  }

  const byDay: ManagerActivityAnalytics['byDay'] = []
  const startShift = new Date(new Date(fromISO).getTime() - off * 60000)
  const endShift = new Date(new Date(toISO).getTime() - off * 60000)
  let cursor = new Date(
    Date.UTC(
      startShift.getUTCFullYear(),
      startShift.getUTCMonth(),
      startShift.getUTCDate(),
    ),
  )
  for (let i = 0; i < 92 && cursor < endShift; i++) {
    const key = cursor.toISOString().slice(0, 10)
    const v = dayMap.get(key) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
    byDay.push({ date: key, ...v })
    cursor = new Date(cursor)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  let byHour: ManagerActivityAnalytics['byHour'] = null
  if (byDay.length === 1) {
    const localHourExpr = `EXTRACT(HOUR FROM (f.first_at AT TIME ZONE 'UTC') - make_interval(mins => $4::int))::int`
    const hourRows = await query<{ h: number; type: ChannelType; people: string }>(
      `SELECT ${localHourExpr} AS h, ch.type,
              count(*)::int AS people
         FROM (${FIRST_CONTACT_CTE}) f
         JOIN channels ch ON ch.id = f.channel_id
        WHERE f.first_at >= $2 AND f.first_at < $3
        GROUP BY 1, 2`,
      dayParams,
    )
    const hourMap = new Map<number, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
    for (const r of hourRows) {
      const cur = hourMap.get(r.h) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
      // Пропускаем типы вне панельного набора (personal-аккаунты и legacy-мусор).
      if (!(r.type in cur)) continue
      cur[r.type as PanelChannelType] = Number(r.people)
      hourMap.set(r.h, cur)
    }
    byHour = []
    for (let h = 0; h < 24; h++) {
      const v = hourMap.get(h) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
      byHour.push({ hour: h, ...v })
    }
  }

  return {
    from: fromISO,
    to: toISO,
    totalPeople: Number(totalRows[0]?.people ?? 0),
    byDay,
    byHour,
  }
}

/** Per-manager activity analytics (time-cached). */
export const getManagerActivityAnalytics = cachedAnalytics(
  getManagerActivityAnalyticsUncached,
  ['getManagerActivityAnalytics'],
)
