/**
 * Analytics & reporting: admin stats, lead/messenger analytics, conversion
 * goals, admin dashboard rollups and source groups.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { query } from '../db'
import type {
  ChannelStatus,
  ChannelType,
  Conversation,
  LeadStatus,
  Manager,
  Message,
  NotLiquidReason,
} from '../types'
import {
  effectiveStatusSql,
  MESSAGE_REPLY_JOIN,
  MESSAGE_SELECT,
  toConversation,
  toMessage,
  type ConversationRow,
  type MessageRow,
} from './shared'
// Cross-domain reads. Imported from the facade (lib/data) rather than the
// individual domain modules to keep a single public surface; these are only
// ever called at runtime, so the resulting import cycle is safe.
import {
  listAllChannels,
  listChannels,
  listConversations,
  listManagers,
} from '../data'

/* ------------------------------ Stats ------------------------------- */

export interface AdminStats {
  totalManagers: number
  activeManagers: number
  blockedManagers: number
  totalChannels: number
  connectedChannels: number
  channelsByType: Record<ChannelType, number>
}

export async function getAdminStats(): Promise<AdminStats> {
  const [managers, channels] = await Promise.all([
    listManagers(),
    listAllChannels(),
  ])
  return {
    totalManagers: managers.length,
    activeManagers: managers.filter((m) => m.status === 'active').length,
    blockedManagers: managers.filter((m) => m.status === 'blocked').length,
    totalChannels: channels.length,
    connectedChannels: channels.filter((c) => c.status === 'connected').length,
    channelsByType: {
      telegram: channels.filter((c) => c.type === 'telegram').length,
      whatsapp: channels.filter((c) => c.type === 'whatsapp').length,
      livechat: channels.filter((c) => c.type === 'livechat').length,
      max: channels.filter((c) => c.type === 'max').length,
      vk: channels.filter((c) => c.type === 'vk').length,
    },
  }
}

export interface ManagerStats {
  totalChannels: number
  connectedChannels: number
  pendingChannels: number
  unreadMessages: number
  openConversations: number
}

export async function getManagerStats(
  managerId: string,
): Promise<ManagerStats> {
  const [channels, conversations] = await Promise.all([
    listChannels(managerId),
    listConversations(managerId),
  ])
  return {
    totalChannels: channels.length,
    connectedChannels: channels.filter((c) => c.status === 'connected').length,
    pendingChannels: channels.filter((c) => c.status === 'pending').length,
    unreadMessages: conversations.reduce((sum, c) => sum + c.unread, 0),
    openConversations: conversations.length,
  }
}

/* ------------------- Lead & messenger analytics -------------------- */

export type GoalMessenger = 'any' | 'telegram' | 'whatsapp'
export type ClickMessenger = 'telegram' | 'whatsapp'

function emptyStatusCounts(): Record<LeadStatus, number> {
  return { unsubscribed: 0, liquid: 0, not_liquid: 0, transferred: 0 }
}

function emptyReasonCounts(): Record<NotLiquidReason, number> {
  return { geo: 0, under18: 0, na: 0, trash: 0 }
}

export interface LeadAnalytics {
  /** Total leads (conversations that wrote in). */
  totalLeads: number
  /** Lead count grouped by effective status. */
  byStatus: Record<LeadStatus, number>
  /** «Не ликвид» lead count grouped by reason sub-status. */
  byReason: Record<NotLiquidReason, number>
  /** Leads whose first message arrived within the last 7 days. */
  newThisWeek: number
  /** Leads with at least one unanswered incoming message. */
  unanswered: number
  /** New leads per day for the last 7 days (oldest first). */
  byDay: { date: string; count: number }[]
}

/**
 * Lead analytics for a manager (or the whole system when managerId is omitted).
 * "New leads per day" uses each conversation's FIRST message timestamp so the
 * dynamics reflect when a contact actually started writing in.
 */
export async function getLeadAnalytics(
  managerId?: string,
): Promise<LeadAnalytics> {
  const scope = managerId ? 'WHERE manager_id = $1' : ''
  const params = managerId ? [managerId] : []

  const [statusRows, reasonRows, totalRows, weekRows, byDayRows] =
    await Promise.all([
    query<{ eff: LeadStatus; n: string }>(
      `SELECT ${effectiveStatusSql()} AS eff, count(*)::int AS n
         FROM conversations ${scope}
        GROUP BY eff`,
      params,
    ),
    query<{ reason: NotLiquidReason; n: string }>(
      `SELECT status_detail AS reason, count(*)::int AS n
         FROM conversations ${scope ? `${scope} AND` : 'WHERE'}
              status = 'not_liquid' AND status_detail IS NOT NULL
        GROUP BY status_detail`,
      params,
    ),
    query<{ total: string; unanswered: string }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE unread > 0)::int AS unanswered
         FROM conversations ${scope}`,
      params,
    ),
    query<{ n: string }>(
      `SELECT count(*)::int AS n FROM (
         SELECT c.id, MIN(m.created_at) AS first_at
           FROM conversations c
           JOIN messages m ON m.conversation_id = c.id
          ${managerId ? 'WHERE c.manager_id = $1' : ''}
          GROUP BY c.id
       ) t
       WHERE first_at >= now() - interval '7 days'`,
      params,
    ),
    query<{ d: string | Date; n: string }>(
      `SELECT date_trunc('day', first_at) AS d, count(*)::int AS n FROM (
         SELECT c.id, MIN(m.created_at) AS first_at
           FROM conversations c
           JOIN messages m ON m.conversation_id = c.id
          ${managerId ? 'WHERE c.manager_id = $1' : ''}
          GROUP BY c.id
       ) t
       WHERE first_at >= now() - interval '6 days'
       GROUP BY 1
       ORDER BY 1`,
      params,
    ),
  ])

  const byStatus = emptyStatusCounts()
  for (const r of statusRows) {
    if (r.eff in byStatus) byStatus[r.eff] = Number(r.n)
  }

  const byReason = emptyReasonCounts()
  for (const r of reasonRows) {
    if (r.reason in byReason) byReason[r.reason] = Number(r.n)
  }

  // Build a dense 7-day series (fill gaps with 0) so the chart is stable.
  const dayMap = new Map<string, number>()
  for (const r of byDayRows) {
    const key = new Date(r.d).toISOString().slice(0, 10)
    dayMap.set(key, Number(r.n))
  }
  const byDay: { date: string; count: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    byDay.push({ date: key, count: dayMap.get(key) ?? 0 })
  }

  return {
    totalLeads: Number(totalRows[0]?.total ?? 0),
    unanswered: Number(totalRows[0]?.unanswered ?? 0),
    newThisWeek: Number(weekRows[0]?.n ?? 0),
    byStatus,
    byReason,
    byDay,
  }
}

/** Record a chat → messenger transition (off-hours widget link tap). */
export async function recordMessengerClick(
  channelId: string | null,
  messenger: ClickMessenger,
): Promise<void> {
  await query(
    `INSERT INTO messenger_clicks (channel_id, messenger) VALUES ($1, $2)`,
    [channelId, messenger],
  )
}

export interface MessengerAnalytics {
  totalClicks: number
  telegramClicks: number
  whatsappClicks: number
  /** Clicks per day for the last 7 days, split by messenger (oldest first). */
  byDay: { date: string; telegram: number; whatsapp: number }[]
}

/**
 * Chat → messenger transition analytics. Scoped to a manager's channels when
 * managerId is supplied, otherwise system-wide (admin).
 */
export async function getMessengerAnalytics(
  managerId?: string,
): Promise<MessengerAnalytics> {
  const join = managerId
    ? 'JOIN channels ch ON ch.id = mc.channel_id AND ch.manager_id = $1'
    : ''
  const params = managerId ? [managerId] : []

  const [totals, byDayRows] = await Promise.all([
    query<{ messenger: ClickMessenger; n: string }>(
      `SELECT mc.messenger, count(*)::int AS n
         FROM messenger_clicks mc ${join}
        GROUP BY mc.messenger`,
      params,
    ),
    query<{ d: string | Date; messenger: ClickMessenger; n: string }>(
      `SELECT date_trunc('day', mc.created_at) AS d, mc.messenger,
              count(*)::int AS n
         FROM messenger_clicks mc ${join}
        WHERE mc.created_at >= now() - interval '6 days'
        GROUP BY 1, 2
        ORDER BY 1`,
      params,
    ),
  ])

  let telegramClicks = 0
  let whatsappClicks = 0
  for (const r of totals) {
    if (r.messenger === 'telegram') telegramClicks = Number(r.n)
    if (r.messenger === 'whatsapp') whatsappClicks = Number(r.n)
  }

  const dayMap = new Map<string, { telegram: number; whatsapp: number }>()
  for (const r of byDayRows) {
    const key = new Date(r.d).toISOString().slice(0, 10)
    const cur = dayMap.get(key) ?? { telegram: 0, whatsapp: 0 }
    cur[r.messenger] = Number(r.n)
    dayMap.set(key, cur)
  }
  const byDay: MessengerAnalytics['byDay'] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const v = dayMap.get(key) ?? { telegram: 0, whatsapp: 0 }
    byDay.push({ date: key, telegram: v.telegram, whatsapp: v.whatsapp })
  }

  return {
    totalClicks: telegramClicks + whatsappClicks,
    telegramClicks,
    whatsappClicks,
    byDay,
  }
}

/* --------------------------- Conversion goals --------------------------- */

export interface ConversionGoal {
  id: string
  name: string
  messenger: GoalMessenger
  active: boolean
  createdAt: string
}

interface ConversionGoalRow {
  id: string
  name: string
  messenger: GoalMessenger
  active: boolean
  created_at: string | Date
}

function toGoal(r: ConversionGoalRow): ConversionGoal {
  return {
    id: r.id,
    name: r.name,
    messenger: r.messenger,
    active: r.active,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

export async function listConversionGoals(): Promise<ConversionGoal[]> {
  const rows = await query<ConversionGoalRow>(
    `SELECT * FROM conversion_goals ORDER BY created_at ASC`,
  )
  return rows.map(toGoal)
}

export async function createConversionGoal(input: {
  name: string
  messenger: GoalMessenger
}): Promise<ConversionGoal> {
  const rows = await query<ConversionGoalRow>(
    `INSERT INTO conversion_goals (name, messenger) VALUES ($1, $2) RETURNING *`,
    [input.name.trim(), input.messenger],
  )
  return toGoal(rows[0])
}

export async function updateConversionGoal(
  id: string,
  input: { name?: string; messenger?: GoalMessenger; active?: boolean },
): Promise<void> {
  await query(
    `UPDATE conversion_goals
        SET name = COALESCE($2, name),
            messenger = COALESCE($3, messenger),
            active = COALESCE($4, active)
      WHERE id = $1`,
    [id, input.name?.trim() ?? null, input.messenger ?? null, input.active ?? null],
  )
}

export async function deleteConversionGoal(id: string): Promise<void> {
  await query(`DELETE FROM conversion_goals WHERE id = $1`, [id])
}

export interface GoalResult extends ConversionGoal {
  /** Number of messenger transitions matching this goal's filter. */
  completions: number
}

/**
 * Conversion goals with their completion counts (matching messenger clicks).
 * Scoped to a manager's channels when managerId is supplied.
 */
export async function getConversionGoalResults(
  managerId?: string,
): Promise<GoalResult[]> {
  const [goals, messenger] = await Promise.all([
    listConversionGoals(),
    getMessengerAnalytics(managerId),
  ])
  return goals.map((g) => {
    let completions = 0
    if (g.messenger === 'telegram') completions = messenger.telegramClicks
    else if (g.messenger === 'whatsapp') completions = messenger.whatsappClicks
    else completions = messenger.totalClicks
    return { ...g, completions }
  })
}

/* ----------------------- Admin dashboard rollups ----------------------- */

export interface ManagerPerformance {
  manager: Manager
  /** Total leads (conversations) owned by this manager. */
  totalLeads: number
  /** Leads whose first message arrived within the last 7 days. */
  newThisWeek: number
  /** Leads with at least one unanswered incoming message. */
  unanswered: number
  /** Effective-status breakdown. */
  byStatus: Record<LeadStatus, number>
  /** Chat → messenger transitions attributed to this manager's channels. */
  clicks: number
  /** Connected vs total channels. */
  connectedChannels: number
  totalChannels: number
  /** ISO timestamp of the most recent message in any of their conversations. */
  lastActivityAt: string | null
}

/**
 * Per-manager performance rollup powering the admin overview leaderboard. Every
 * manager is included (even with zero activity) so the admin sees full coverage.
 * A handful of grouped queries are stitched together in JS keyed by manager id —
 * cheap at this app's scale and far clearer than one giant join.
 */
export async function getManagerPerformance(): Promise<ManagerPerformance[]> {
  const managers = await listManagers()
  if (managers.length === 0) return []

  const [convRows, weekRows, clickRows, channelRows] = await Promise.all([
    query<{
      manager_id: string
      total: string
      unanswered: string
      eff_unsubscribed: string
      eff_liquid: string
      eff_not_liquid: string
      eff_transferred: string
      last_activity: string | Date | null
    }>(
      `SELECT manager_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE unread > 0)::int AS unanswered,
              count(*) FILTER (WHERE eff = 'unsubscribed')::int AS eff_unsubscribed,
              count(*) FILTER (WHERE eff = 'liquid')::int AS eff_liquid,
              count(*) FILTER (WHERE eff = 'not_liquid')::int AS eff_not_liquid,
              count(*) FILTER (WHERE eff = 'transferred')::int AS eff_transferred,
              max(last_message_at) AS last_activity
         FROM (
           SELECT manager_id, unread, last_message_at,
                    ${effectiveStatusSql()} AS eff
             FROM conversations
         ) c
        GROUP BY manager_id`,
    ),
    query<{ manager_id: string; n: string }>(
      `SELECT manager_id, count(*)::int AS n FROM (
         SELECT c.id, c.manager_id, MIN(m.created_at) AS first_at
           FROM conversations c
           JOIN messages m ON m.conversation_id = c.id
          GROUP BY c.id, c.manager_id
       ) t
       WHERE first_at >= now() - interval '7 days'
       GROUP BY manager_id`,
    ),
    query<{ manager_id: string; n: string }>(
      `SELECT ch.manager_id, count(*)::int AS n
         FROM messenger_clicks mc
         JOIN channels ch ON ch.id = mc.channel_id
        WHERE ch.manager_id IS NOT NULL
        GROUP BY ch.manager_id`,
    ),
    query<{ manager_id: string; total: string; connected: string }>(
      `SELECT manager_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'connected')::int AS connected
         FROM channels
        WHERE manager_id IS NOT NULL
        GROUP BY manager_id`,
    ),
  ])

  const convById = new Map(convRows.map((r) => [r.manager_id, r]))
  const weekById = new Map(weekRows.map((r) => [r.manager_id, Number(r.n)]))
  const clicksById = new Map(clickRows.map((r) => [r.manager_id, Number(r.n)]))
  const channelsById = new Map(channelRows.map((r) => [r.manager_id, r]))

  return managers.map((manager) => {
    const c = convById.get(manager.id)
    const ch = channelsById.get(manager.id)
    const byStatus = emptyStatusCounts()
    if (c) {
      byStatus.unsubscribed = Number(c.eff_unsubscribed)
      byStatus.liquid = Number(c.eff_liquid)
      byStatus.not_liquid = Number(c.eff_not_liquid)
      byStatus.transferred = Number(c.eff_transferred)
    }
    return {
      manager,
      totalLeads: Number(c?.total ?? 0),
      newThisWeek: weekById.get(manager.id) ?? 0,
      unanswered: Number(c?.unanswered ?? 0),
      byStatus,
      clicks: clicksById.get(manager.id) ?? 0,
      connectedChannels: Number(ch?.connected ?? 0),
      totalChannels: Number(ch?.total ?? 0),
      lastActivityAt: c?.last_activity
        ? new Date(c.last_activity).toISOString()
        : null,
    }
  })
}

/**
 * Admin-only: fetch a single conversation by id WITHOUT manager scoping, along
 * with its owning manager's display name. Authorization is enforced by the
 * caller (server action guarded with requireAdmin).
 */
export async function getConversationAdmin(
  conversationId: string,
): Promise<(Conversation & { managerName: string | null }) | null> {
  const rows = await query<
    ConversationRow & { channel_name: string | null; manager_name: string | null }
  >(
    `SELECT c.*, ch.name AS channel_name, m.name AS manager_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN managers m ON m.id = c.manager_id
      WHERE c.id = $1
      LIMIT 1`,
    [conversationId],
  )
  if (!rows[0]) return null
  return {
    ...toConversation(rows[0]),
    channelName: rows[0].channel_name ?? undefined,
    managerName: rows[0].manager_name ?? null,
  }
}

/**
 * Admin-only: full message transcript for any conversation (no manager scope).
 * Authorization is enforced by the caller (requireAdmin).
 */
export async function listMessagesAdmin(
  conversationId: string,
): Promise<Message[]> {
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
       FROM messages m
       ${MESSAGE_REPLY_JOIN}
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC`,
    [conversationId],
  )
  return rows.map(toMessage)
}

/**
 * Admin-only: list EVERY conversation across all managers/channels, enriched
 * with the owning manager's and source channel's display names. Powers the
 * God-mode console conversation rail. No manager scoping — authorization is
 * enforced by the caller (requireAdmin). Optional case-insensitive search over
 * contact name/handle and last message, plus optional channel-type filter.
 */
export async function listConversationsAdmin(opts?: {
  search?: string
  channelType?: ChannelType
  limit?: number
}): Promise<Array<Conversation & { managerName: string | null }>> {
  const params: unknown[] = []
  const where: string[] = []

  const search = opts?.search?.trim()
  if (search) {
    params.push(`%${search}%`)
    const p = `$${params.length}`
    where.push(
      `(c.contact_name ILIKE ${p} OR c.contact_handle ILIKE ${p} OR c.last_message ILIKE ${p})`,
    )
  }
  if (opts?.channelType) {
    params.push(opts.channelType)
    where.push(`c.channel_type = $${params.length}`)
  }

  const limit = Math.min(Math.max(opts?.limit ?? 300, 1), 1000)
  params.push(limit)
  const limitParam = `$${params.length}`

  const rows = await query<
    ConversationRow & { channel_name: string | null; manager_name: string | null }
  >(
    `SELECT c.*, ch.name AS channel_name, m.name AS manager_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN managers m ON m.id = c.manager_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.last_message_at DESC
      LIMIT ${limitParam}`,
    params,
  )
  return rows.map((r) => ({
    ...toConversation(r),
    channelName: r.channel_name ?? undefined,
    managerName: r.manager_name ?? null,
  }))
}

/* --------------------------- Source groups ----------------------------- */
// A "source group" bundles the channels (Telegram / WhatsApp accounts + the
// live-chat widget) that belong to ONE website. It is configured once and used
// only for the admin overview report — it never touches inbox routing.

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

/** All source groups with their member channels. */
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
    `SELECT g.id, g.name, g.created_at,
            ch.id AS channel_id, ch.type AS channel_type, ch.name AS channel_name,
            ch.detail AS channel_detail, ch.status AS channel_status
       FROM source_groups g
       LEFT JOIN source_group_channels sgc ON sgc.group_id = g.id
       LEFT JOIN channels ch ON ch.id = sgc.channel_id
      ORDER BY g.created_at ASC, ch.type ASC, ch.name ASC`,
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

/** Replace a group's channel membership with the given channel ids. */
async function setGroupChannels(
  groupId: string,
  channelIds: string[],
): Promise<void> {
  await query(`DELETE FROM source_group_channels WHERE group_id = $1`, [groupId])
  const ids = [...new Set(channelIds)].filter(Boolean)
  for (const channelId of ids) {
    // A channel belongs to at most one group; steal it from any other group so
    // the latest assignment wins instead of erroring on the UNIQUE constraint.
    await query(
      `INSERT INTO source_group_channels (group_id, channel_id)
       VALUES ($1, $2)
       ON CONFLICT (channel_id) DO UPDATE SET group_id = EXCLUDED.group_id`,
      [groupId, channelId],
    )
  }
}

export async function createSourceGroup(
  name: string,
  channelIds: string[],
): Promise<SourceGroup> {
  const rows = await query<{ id: string }>(
    `INSERT INTO source_groups (name) VALUES ($1) RETURNING id`,
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
    await query(`UPDATE source_groups SET name = $2 WHERE id = $1`, [
      id,
      input.name.trim() || 'Источник',
    ])
  }
  if (input.channelIds) {
    await setGroupChannels(id, input.channelIds)
  }
}

export async function deleteSourceGroup(id: string): Promise<void> {
  await query(`DELETE FROM source_groups WHERE id = $1`, [id])
}

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
  byType: Record<ChannelType, { people: number; messages: number }>
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

function emptyTypeStats(): Record<ChannelType, { people: number; messages: number }> {
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
export async function getGroupAnalytics(
  groupId: string,
  fromISO: string,
  toISO: string,
  // Client timezone offset, in the JS `Date.getTimezoneOffset()` convention
  // (minutes; MSK = -180). Day buckets are computed in the visitor admin's
  // local calendar so "today" lines up with their clock, not the server's UTC.
  tzOffsetMinutes = 0,
): Promise<GroupAnalytics> {
  const groupRows = await query<{ name: string }>(
    `SELECT name FROM source_groups WHERE id = $1`,
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
         FROM source_group_channels sgc
         JOIN conversations c ON c.channel_id = sgc.channel_id
         JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.group_id = $1`,
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
         FROM source_group_channels sgc
         JOIN channels ch ON ch.id = sgc.channel_id
         LEFT JOIN conversations c ON c.channel_id = ch.id
         LEFT JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.group_id = $1
        GROUP BY ch.id, ch.name, ch.type
        ORDER BY people DESC, ch.name ASC`,
      params,
    ),
    query<{ d: string; type: ChannelType; people: string }>(
      `SELECT ${localDayExpr} AS d, ch.type,
              count(DISTINCT c.id)::int AS people
         FROM source_group_channels sgc
         JOIN channels ch ON ch.id = sgc.channel_id
         JOIN conversations c ON c.channel_id = ch.id
         JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.group_id = $1
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
    // Guard against channel types outside the known union (legacy/bad rows):
    // a direct byType[c.type] would be undefined and crash on `.people`.
    if (!byType[c.type]) continue
    byType[c.type].people += c.people
    byType[c.type].messages += c.messages
  }

  // Dense per-day series across [from, to) so the chart has no gaps. `r.d` is
  // already a local 'YYYY-MM-DD' string (bucketed in the admin's timezone).
  const dayMap = new Map<string, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
  for (const r of dayRows) {
    const cur = dayMap.get(r.d) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
    cur[r.type] = Number(r.people)
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
         FROM source_group_channels sgc
         JOIN channels ch ON ch.id = sgc.channel_id
         JOIN conversations c ON c.channel_id = ch.id
         JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.group_id = $1
        GROUP BY 1, 2`,
      dayParams,
    )
    const hourMap = new Map<number, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
    for (const r of hourRows) {
      const cur = hourMap.get(r.h) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
      cur[r.type] = Number(r.people)
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
export async function getManagerActivityAnalytics(
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
    cur[r.type] = Number(r.people)
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
      cur[r.type] = Number(r.people)
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

/* -------------------------------------------------------------------------- */
/*  Quick replies (manager-scoped canned responses)                           */
/* -------------------------------------------------------------------------- */

