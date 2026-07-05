import 'server-only'
import { query } from '../db'
import {
  type AutopilotRule,
  type AutopilotRuleConfig,
  normalizeEvent,
  normalizeRuleConfig,
} from './match'

/**
 * Server-only data access for Autopilot (panel side). The worker has its own
 * lightweight reads in worker/src/repo.ts; this file is for the Next.js panel
 * (CRUD from server actions + runtime reads in the live-chat ingest route).
 *
 * Everything is scoped by manager_id — a manager only ever sees/edits their own
 * settings, rules and fire-history.
 */

export interface AutopilotSettings {
  managerId: string
  enabled: boolean
}

interface SettingsRow {
  manager_id: string
  enabled: boolean
}

interface RuleRow {
  id: string
  manager_id: string
  name: string
  enabled: boolean
  sort_order: number
  event: string
  config: unknown
}

function mapRule(row: RuleRow): AutopilotRule {
  return {
    id: row.id,
    managerId: row.manager_id,
    name: row.name ?? '',
    enabled: row.enabled,
    sortOrder: row.sort_order ?? 0,
    event: normalizeEvent(row.event),
    config: normalizeRuleConfig(row.config),
  }
}

/** Read the master switch for a manager (defaults to disabled if no row yet). */
export async function getAutopilotSettings(
  managerId: string,
): Promise<AutopilotSettings> {
  const rows = await query<SettingsRow>(
    'SELECT manager_id, enabled FROM autopilot_settings WHERE manager_id = $1',
    [managerId],
  )
  return { managerId, enabled: rows[0]?.enabled ?? false }
}

/** Flip the master switch (upsert). */
export async function setAutopilotEnabled(
  managerId: string,
  enabled: boolean,
): Promise<void> {
  await query(
    `INSERT INTO autopilot_settings (manager_id, enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (manager_id)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [managerId, enabled],
  )
}

/** All rules for a manager, in priority order. */
export async function listRules(managerId: string): Promise<AutopilotRule[]> {
  const rows = await query<RuleRow>(
    `SELECT id, manager_id, name, enabled, sort_order, event, config
       FROM autopilot_rules
      WHERE manager_id = $1
      ORDER BY sort_order ASC, created_at ASC`,
    [managerId],
  )
  return rows.map(mapRule)
}

/** Count of enabled rules (for the inbox toggle status line). */
export async function countEnabledRules(managerId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM autopilot_rules
      WHERE manager_id = $1 AND enabled = true`,
    [managerId],
  )
  return Number(rows[0]?.n ?? 0)
}

/**
 * Runtime read for the live-chat ingest route: the master switch + only the
 * enabled rules, already sorted. Returns an empty rule list when the master
 * switch is off so callers can skip work cheaply.
 */
export async function getActiveAutopilot(
  managerId: string,
): Promise<{ enabled: boolean; rules: AutopilotRule[] }> {
  const settings = await getAutopilotSettings(managerId)
  if (!settings.enabled) return { enabled: false, rules: [] }
  const rows = await query<RuleRow>(
    `SELECT id, manager_id, name, enabled, sort_order, event, config
       FROM autopilot_rules
      WHERE manager_id = $1 AND enabled = true
      ORDER BY sort_order ASC, created_at ASC`,
    [managerId],
  )
  return { enabled: true, rules: rows.map(mapRule) }
}

export interface CreateRuleInput {
  name: string
  event: string
  enabled: boolean
  config: AutopilotRuleConfig
}

/** Create a rule, appended at the end of the manager's priority list. */
export async function createRule(
  managerId: string,
  input: CreateRuleInput,
): Promise<AutopilotRule> {
  const orderRows = await query<{ next: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
       FROM autopilot_rules WHERE manager_id = $1`,
    [managerId],
  )
  const sortOrder = orderRows[0]?.next ?? 0
  const rows = await query<RuleRow>(
    `INSERT INTO autopilot_rules
       (manager_id, name, enabled, sort_order, event, config)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, manager_id, name, enabled, sort_order, event, config`,
    [
      managerId,
      input.name,
      input.enabled,
      sortOrder,
      normalizeEvent(input.event),
      JSON.stringify(normalizeRuleConfig(input.config)),
    ],
  )
  return mapRule(rows[0])
}

export interface UpdateRuleInput {
  name: string
  event: string
  enabled: boolean
  config: AutopilotRuleConfig
}

/** Update an existing rule (scoped to the owning manager). */
export async function updateRule(
  managerId: string,
  ruleId: string,
  input: UpdateRuleInput,
): Promise<AutopilotRule | null> {
  const rows = await query<RuleRow>(
    `UPDATE autopilot_rules
        SET name = $3, enabled = $4, event = $5, config = $6::jsonb,
            updated_at = now()
      WHERE id = $2 AND manager_id = $1
      RETURNING id, manager_id, name, enabled, sort_order, event, config`,
    [
      managerId,
      ruleId,
      input.name,
      input.enabled,
      normalizeEvent(input.event),
      JSON.stringify(normalizeRuleConfig(input.config)),
    ],
  )
  return rows[0] ? mapRule(rows[0]) : null
}

/** Toggle a single rule's enabled flag. */
export async function setRuleEnabled(
  managerId: string,
  ruleId: string,
  enabled: boolean,
): Promise<void> {
  await query(
    `UPDATE autopilot_rules SET enabled = $3, updated_at = now()
      WHERE id = $2 AND manager_id = $1`,
    [managerId, ruleId, enabled],
  )
}

/** Delete a rule (fire-history cascades). */
export async function deleteRule(
  managerId: string,
  ruleId: string,
): Promise<void> {
  await query('DELETE FROM autopilot_rules WHERE id = $2 AND manager_id = $1', [
    managerId,
    ruleId,
  ])
}

/**
 * Atomically claim the "first fire" of a rule on a conversation. Returns true
 * if THIS call recorded the fire (i.e. it had not fired before), false if it
 * was already recorded. Used to dedupe 'first_message' / 'oncePerConversation'
 * / 'no_response' so a rule never double-sends, even under concurrent inbounds.
 */
export async function tryRecordFire(
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

/** Which of the given rule ids have already fired on this conversation. */
export async function firedRuleIds(
  conversationId: string,
  ruleIds: string[],
): Promise<Set<string>> {
  if (ruleIds.length === 0) return new Set()
  const rows = await query<{ rule_id: string }>(
    `SELECT rule_id FROM autopilot_fires
      WHERE conversation_id = $1 AND rule_id = ANY($2::uuid[])`,
    [conversationId, ruleIds],
  )
  return new Set(rows.map((r) => r.rule_id))
}

/** Persist a new priority ordering for the manager's rules. */
export async function reorderRules(
  managerId: string,
  orderedIds: string[],
): Promise<void> {
  let i = 0
  for (const id of orderedIds) {
    await query(
      `UPDATE autopilot_rules SET sort_order = $3, updated_at = now()
        WHERE id = $2 AND manager_id = $1`,
      [managerId, id, i],
    )
    i += 1
  }
}
