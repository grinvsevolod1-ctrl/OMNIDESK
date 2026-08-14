/**
 * Analytics & reporting: admin stats, lead/messenger analytics, conversion
 * goals, admin dashboard rollups and source groups.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { cachedAnalytics } from '../analytics-cache'
import { query } from '../db'
import { mskDayKey } from '../time'
import type {
  LeadStatus,
  Manager,
  NotLiquidReason,
  PanelChannelType,
} from '../types'
import { effectiveStatusSql } from './shared'
import {
  listAllChannels,
  listChannels,
  listConversations,
  listManagers,
} from '../data'

export interface AdminStats {
  totalManagers: number
  activeManagers: number
  blockedManagers: number
  totalChannels: number
  connectedChannels: number
  // PanelChannelType: personal-аккаунты god-панели в admin-статистику не
  // входят (listAllChannels их уже отфильтровывает).
  channelsByType: Record<PanelChannelType, number>
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

export type ClickMessenger = 'telegram' | 'whatsapp'

function emptyStatusCounts(): Record<LeadStatus, number> {
  return { unsubscribed: 0, handoff: 0, liquid: 0, not_liquid: 0, transferred: 0 }
}

function emptyReasonCounts(): Record<NotLiquidReason, number> {
  return { geo: 0, under18: 0, na: 0, trash: 0 }
}

export interface LeadAnalytics {
  totalLeads: number
  byStatus: Record<LeadStatus, number>
  byReason: Record<NotLiquidReason, number>
  newThisWeek: number
  unanswered: number
  byDay: { date: string; count: number }[]
}

async function getLeadAnalyticsUncached(
  managerId?: string,
): Promise<LeadAnalytics> {
  const scope = managerId ? 'WHERE manager_id = $1' : ''
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
    query<{ n: string }>(
      `SELECT count(*)::int AS n
         FROM conversations
         ${reasonScope} first_message_at >= now() - interval '7 days'`,
      params,
    ),
    query<{ d: string; n: string }>(
      // Day buckets are computed in MSK and returned as text: date_trunc in
      // the DB-server timezone + toISOString() in JS shifted the boundary a
      // day back whenever the two zones disagreed (the workspace-lock bug).
      `SELECT to_char(first_message_at AT TIME ZONE 'Europe/Moscow',
                      'YYYY-MM-DD') AS d,
              count(*)::int AS n
         FROM conversations
         ${reasonScope} first_message_at >= now() - interval '7 days'
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

  const dayMap = new Map<string, number>()
  for (const r of byDayRows) {
    dayMap.set(r.d, Number(r.n))
  }
  // Axis of the last 7 MSK calendar days (MSK has no DST, so -24h is safe).
  const byDay: { date: string; count: number }[] = []
  const now = Date.now()
  for (let i = 6; i >= 0; i--) {
    const key = mskDayKey(new Date(now - i * 24 * 60 * 60 * 1000))
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

export const getLeadAnalytics = cachedAnalytics(getLeadAnalyticsUncached, [
  'getLeadAnalytics',
])

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
  byDay: { date: string; telegram: number; whatsapp: number }[]
}

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
    query<{ d: string; messenger: ClickMessenger; n: string }>(
      // MSK day buckets as text — see the comment in getLeadAnalytics.
      `SELECT to_char(mc.created_at AT TIME ZONE 'Europe/Moscow',
                      'YYYY-MM-DD') AS d,
              mc.messenger,
              count(*)::int AS n
         FROM messenger_clicks mc ${join}
        WHERE mc.created_at >= now() - interval '7 days'
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
    const cur = dayMap.get(r.d) ?? { telegram: 0, whatsapp: 0 }
    cur[r.messenger] = Number(r.n)
    dayMap.set(r.d, cur)
  }
  const byDay: MessengerAnalytics['byDay'] = []
  const now = Date.now()
  for (let i = 6; i >= 0; i--) {
    const key = mskDayKey(new Date(now - i * 24 * 60 * 60 * 1000))
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

export const getMessengerAnalytics = cachedAnalytics(
  getMessengerAnalyticsUncached,
  ['getMessengerAnalytics'],
)

export interface ManagerPerformance {
  manager: Manager
  totalLeads: number
  newThisWeek: number
  unanswered: number
  byStatus: Record<LeadStatus, number>
  clicks: number
  connectedChannels: number
  totalChannels: number
  lastActivityAt: string | null
}

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

export const getManagerPerformance = cachedAnalytics(
  getManagerPerformanceUncached,
  ['getManagerPerformance'],
)

/*
 * Админ-просмотр диалогов (карточка/транскрипт/список без manager-скоупа)
 * и активность менеджеров перенесены в analytics-admin.ts; re-export для
 * совместимости импортов.
 */
export {
  getConversationAdmin,
  listConversationsAdmin,
  listManagerActivity,
  listMessagesAdmin,
  type ManagerActivityRow,
} from './analytics-admin'

export * from './analytics-groups'
