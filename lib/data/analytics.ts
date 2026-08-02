/**
 * Analytics & reporting: admin stats, lead/messenger analytics, conversion
 * goals, admin dashboard rollups and source groups.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { cachedAnalytics } from '../analytics-cache'
import { query } from '../db'
import type {
  ChannelType,
  Conversation,
  LeadStatus,
  Manager,
  Message,
  NotLiquidReason,
} from '../types'
import {
  conversationColumns,
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
  return { unsubscribed: 0, handoff: 0, liquid: 0, not_liquid: 0, transferred: 0 }
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
async function getLeadAnalyticsUncached(
  managerId?: string,
): Promise<LeadAnalytics> {
  // Simulator-created conversations are real leads and are counted here just
  // like any other. Only manager scoping is applied.
  const scope = managerId ? 'WHERE manager_id = $1' : ''
  // "Не ликвид" breakdown and the first-message-time windows always need their
  // own WHERE; prepend the manager filter when present.
  const reasonScope = managerId ? 'WHERE manager_id = $1 AND' : 'WHERE'
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
         FROM conversations ${reasonScope}
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
    // Reads the denormalized conversations.first_message_at (maintained by a
    // trigger) instead of aggregating the messages table on every load.
    query<{ n: string }>(
      `SELECT count(*)::int AS n
         FROM conversations
         ${reasonScope} first_message_at >= now() - interval '7 days'`,
      params,
    ),
    query<{ d: string | Date; n: string }>(
      `SELECT date_trunc('day', first_message_at) AS d, count(*)::int AS n
         FROM conversations
         ${reasonScope} first_message_at >= now() - interval '6 days'
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

/** Lead analytics for the manager home dashboard (time-cached). */
export const getLeadAnalytics = cachedAnalytics(getLeadAnalyticsUncached, [
  'getLeadAnalytics',
])

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
async function getMessengerAnalyticsUncached(
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

/** Messenger click analytics (time-cached). */
export const getMessengerAnalytics = cachedAnalytics(
  getMessengerAnalyticsUncached,
  ['getMessengerAnalytics'],
)

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
    `SELECT id, name, messenger, active, created_at
       FROM conversion_goals ORDER BY created_at ASC`,
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
async function getManagerPerformanceUncached(): Promise<ManagerPerformance[]> {
  const managers = await listManagers()
  if (managers.length === 0) return []

  const [convRows, weekRows, clickRows, channelRows] = await Promise.all([
    query<{
      manager_id: string
      total: string
      unanswered: string
      eff_unsubscribed: string
      eff_handoff: string
      eff_liquid: string
      eff_not_liquid: string
      eff_transferred: string
      last_activity: string | Date | null
    }>(
      `SELECT manager_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE unread > 0)::int AS unanswered,
              count(*) FILTER (WHERE eff = 'unsubscribed')::int AS eff_unsubscribed,
              count(*) FILTER (WHERE eff = 'handoff')::int AS eff_handoff,
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
    // Uses the denormalized first_message_at column (trigger-maintained)
    // instead of a full JOIN+MIN aggregation over the messages table.
    query<{ manager_id: string; n: string }>(
      `SELECT manager_id, count(*)::int AS n
         FROM conversations
        WHERE first_message_at >= now() - interval '7 days'
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
      byStatus.handoff = Number(c.eff_handoff)
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

/** Admin overview leaderboard rollup (time-cached). */
export const getManagerPerformance = cachedAnalytics(
  getManagerPerformanceUncached,
  ['getManagerPerformance'],
)

/**
 * Admin-only: fetch a single conversation by id WITHOUT manager scoping, along
 * with its owning manager's display name. Authorization is enforced by the
 * caller (server action guarded with requireAdmin).
 */
export async function getConversationAdmin(
  conversationId: string,
): Promise<
  | (Conversation & { managerName: string | null })
  | null
> {
  const rows = await query<
    ConversationRow & {
      channel_name: string | null
      manager_name: string | null
    }
  >(
    `SELECT ${conversationColumns('c')}, ch.name AS channel_name, m.name AS manager_name
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
  opts?: { limit?: number },
): Promise<Message[]> {
  // Bounded: fetch only the NEWEST N rows (via the DESC subquery), then flip
  // back to ascending for display. An unbounded transcript makes every open /
  // refresh of a long thread ship the entire history over the wire.
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000)
  const rows = await query<MessageRow>(
    `SELECT * FROM (
        SELECT ${MESSAGE_SELECT}
          FROM messages m
          ${MESSAGE_REPLY_JOIN}
         WHERE m.conversation_id = $1
         ORDER BY m.created_at DESC
         LIMIT $2
     ) newest
     ORDER BY newest.created_at ASC`,
    [conversationId, limit],
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
}): Promise<
  Array<Conversation & { managerName: string | null; godUnread: number }>
> {
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
    ConversationRow & {
      channel_name: string | null
      manager_name: string | null
      god_unread: number | string
    }
  >(
    `SELECT ${conversationColumns('c')}, ch.name AS channel_name, m.name AS manager_name,
            (SELECT count(*)
               FROM messages mm
              WHERE mm.conversation_id = c.id
                AND mm.direction = 'out'
                AND mm.created_at > c.god_read_at) AS god_unread
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
    godUnread: Number(r.god_unread),
  }))
}

/* --------------------------------------------------------------------------
 * Domain re-export. Source-group / group-analytics concerns were split into a
 * focused sibling module; callers keep importing them from this module.
 * ------------------------------------------------------------------------ */
export * from './analytics-groups'

