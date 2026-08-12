import { query, one } from './db.js'

/**
 * Autopilot repository for the worker: rules, fire-dedup, anti-ban send
 * counting, the no-response scheduler feed and working-hours lookup.
 */

/** Raw autopilot rule row (worker view; matcher normalizes the config). */
export interface AutopilotRuleRow {
  id: string
  manager_id: string
  name: string
  enabled: boolean
  sort_order: number
  event: string
  config: unknown
}

/** Is the manager's autopilot master switch on? Defaults to OFF when no row. */
export async function autopilotEnabled(managerId: string): Promise<boolean> {
  const row = await one<{ enabled: boolean }>(
    `SELECT enabled FROM autopilot_settings WHERE manager_id = $1`,
    [managerId],
  )
  return !!row?.enabled
}

/** Active rules for a manager, priority order (sort_order asc, then created). */
export async function listEnabledAutopilotRules(
  managerId: string,
): Promise<AutopilotRuleRow[]> {
  return query<AutopilotRuleRow>(
    `SELECT id, manager_id, name, enabled, sort_order, event, config
       FROM autopilot_rules
      WHERE manager_id = $1 AND enabled = true
      ORDER BY sort_order ASC, created_at ASC`,
    [managerId],
  )
}

/**
 * Atomically claim the first fire of a rule on a conversation. Returns true if
 * THIS call recorded it (rule had not fired before), false if already fired.
 * Mirrors the panel-side tryRecordFire so dedupe is consistent across runtimes.
 */
export async function tryRecordAutopilotFire(
  ruleId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO autopilot_fires (rule_id, conversation_id)
     VALUES ($1, $2)
     ON CONFLICT (rule_id, conversation_id) DO NOTHING
     RETURNING id`,
    [ruleId, conversationId],
  )
  return rows.length > 0
}

/** Remove a fire record (used to roll back a claim when the send fails). */
export async function clearAutopilotFire(
  ruleId: string,
  conversationId: string,
): Promise<void> {
  await query(
    `DELETE FROM autopilot_fires WHERE rule_id = $1 AND conversation_id = $2`,
    [ruleId, conversationId],
  )
}

/**
 * Count autopilot sends on a channel within a trailing window (minutes). Used
 * to enforce per-channel anti-ban rate caps for messengers.
 */
export async function countAutopilotSends(
  channelId: string,
  withinMinutes: number,
): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COUNT(*)::int AS n
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1
        AND m.direction = 'out'
        AND m.is_autopilot = true
        AND m.created_at > now() - ($2 || ' minutes')::interval`,
    [channelId, String(withinMinutes)],
  )
  return Number(row?.n ?? 0)
}

/**
 * Conversations with an inbound that hasn't been answered for >= N minutes and
 * where the manager's autopilot is on. Drives the 'no_response' scheduler.
 * Only returns the data the matcher/sender needs; dedupe is checked per rule.
 */
export async function findNoResponseConversations(maxMinutes: number): Promise<
  Array<{
    conversationId: string
    channelId: string
    managerId: string
    channelType: 'telegram' | 'whatsapp' | 'livechat'
    contactHandle: string
    lastInboundText: string
    minutesSilent: number
  }>
> {
  const rows = await query<{
    conversation_id: string
    channel_id: string
    manager_id: string
    channel_type: 'telegram' | 'whatsapp' | 'livechat'
    contact_handle: string
    last_inbound_text: string
    minutes_silent: number
  }>(
    `WITH last_in AS (
       SELECT DISTINCT ON (m.conversation_id)
              m.conversation_id, m.body, m.created_at
         FROM messages m
        WHERE m.direction = 'in'
        ORDER BY m.conversation_id, m.created_at DESC
     ),
     last_out AS (
       SELECT m.conversation_id, MAX(m.created_at) AS created_at
         FROM messages m
        WHERE m.direction = 'out'
        GROUP BY m.conversation_id
     )
     SELECT c.id AS conversation_id, c.channel_id, c.manager_id,
            c.channel_type, c.contact_handle,
            li.body AS last_inbound_text,
            EXTRACT(EPOCH FROM (now() - li.created_at)) / 60 AS minutes_silent
       FROM conversations c
       JOIN last_in li ON li.conversation_id = c.id
       JOIN autopilot_settings s ON s.manager_id = c.manager_id AND s.enabled = true
       LEFT JOIN last_out lo ON lo.conversation_id = c.id
      WHERE (lo.created_at IS NULL OR lo.created_at < li.created_at)
        AND li.created_at < now() - '1 minute'::interval
        AND li.created_at > now() - ($1 || ' minutes')::interval`,
    [String(maxMinutes)],
  )
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    channelId: r.channel_id,
    managerId: r.manager_id,
    channelType: r.channel_type,
    contactHandle: r.contact_handle,
    lastInboundText: r.last_inbound_text,
    minutesSilent: Number(r.minutes_silent),
  }))
}

/** Working-hours JSON for a channel (any type), for the matcher's WH condition. */
export async function getChannelWorkingHours(
  channelId: string,
): Promise<unknown | null> {
  const row = await one<{ config: { widget?: { workingHours?: unknown } } | null }>(
    `SELECT config FROM channels WHERE id = $1`,
    [channelId],
  )
  return row?.config?.widget?.workingHours ?? null
}
