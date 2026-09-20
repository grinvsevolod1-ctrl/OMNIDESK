/**
 * Очередь лидов исходящего контура + тред первого касания (миграция 175).
 *
 * Лиды прилетают из бота-приёмника, назначаются менеджеру round-robin, менеджер
 * пишет первым с прогретого аккаунта. Всё скоупится по assigned_manager_id.
 */
import { query } from '../db'

export type OutreachLeadStatus =
  | 'pending'
  | 'assigned'
  | 'contacted'
  | 'replied'
  | 'won'
  | 'lost'

export interface OutreachLead {
  id: string
  source: string
  tgUserId: string | null
  username: string | null
  phone: string | null
  displayName: string | null
  rawText: string | null
  forwardedFrom: string | null
  status: OutreachLeadStatus
  assignedManagerId: string | null
  accountId: string | null
  contactedAt: string | null
  repliedAt: string | null
  createdAt: string
  updatedAt: string
}

interface LeadRow {
  id: string
  source: string
  tg_user_id: string | null
  username: string | null
  phone: string | null
  display_name: string | null
  raw_text: string | null
  forwarded_from: string | null
  status: OutreachLeadStatus
  assigned_manager_id: string | null
  account_id: string | null
  contacted_at: string | null
  replied_at: string | null
  created_at: string
  updated_at: string
}

function mapLead(r: LeadRow): OutreachLead {
  return {
    id: r.id,
    source: r.source,
    tgUserId: r.tg_user_id,
    username: r.username,
    phone: r.phone,
    displayName: r.display_name,
    rawText: r.raw_text,
    forwardedFrom: r.forwarded_from,
    status: r.status,
    assignedManagerId: r.assigned_manager_id,
    accountId: r.account_id,
    contactedAt: r.contacted_at,
    repliedAt: r.replied_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * Вставить лид с дедупом по tg_user_id. Если такой лид уже есть — возвращает
 * существующий id (ON CONFLICT DO NOTHING + повторный SELECT).
 */
export async function insertLead(input: {
  source?: string
  tgUserId?: string | null
  username?: string | null
  phone?: string | null
  displayName?: string | null
  rawText?: string | null
  forwardedFrom?: string | null
  assignedManagerId?: string | null
}): Promise<{ id: string; deduped: boolean }> {
  const rows = await query<{ id: string }>(
    `INSERT INTO outreach_leads
       (source, tg_user_id, username, phone, display_name, raw_text,
        forwarded_from, assigned_manager_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             CASE WHEN $8::uuid IS NULL THEN 'pending' ELSE 'assigned' END)
     ON CONFLICT (tg_user_id) WHERE tg_user_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      input.source ?? 'telegram_bot',
      input.tgUserId ?? null,
      input.username ?? null,
      input.phone ?? null,
      input.displayName ?? null,
      input.rawText ?? null,
      input.forwardedFrom ?? null,
      input.assignedManagerId ?? null,
    ],
  )
  if (rows[0]) return { id: rows[0].id, deduped: false }
  // Конфликт — достаём существующий.
  const existing = await query<{ id: string }>(
    `SELECT id FROM outreach_leads WHERE tg_user_id = $1`,
    [input.tgUserId],
  )
  return { id: existing[0].id, deduped: true }
}

/** Лиды менеджера (по статусам, свежие сверху). */
export async function listLeadsForManager(
  managerId: string,
  opts?: { statuses?: OutreachLeadStatus[] },
): Promise<OutreachLead[]> {
  const statuses = opts?.statuses
  const rows = await query<LeadRow>(
    `SELECT * FROM outreach_leads
      WHERE assigned_manager_id = $1
        AND ($2::text[] IS NULL OR status = ANY($2::text[]))
      ORDER BY created_at DESC
      LIMIT 500`,
    [managerId, statuses ?? null],
  )
  return rows.map(mapLead)
}

export async function getLead(id: string): Promise<OutreachLead | null> {
  const rows = await query<LeadRow>(`SELECT * FROM outreach_leads WHERE id = $1`, [
    id,
  ])
  return rows[0] ? mapLead(rows[0]) : null
}

/** Лид менеджера (со скоупом) — для гейта в экшенах. */
export async function getLeadForManager(
  id: string,
  managerId: string,
): Promise<OutreachLead | null> {
  const rows = await query<LeadRow>(
    `SELECT * FROM outreach_leads WHERE id = $1 AND assigned_manager_id = $2`,
    [id, managerId],
  )
  return rows[0] ? mapLead(rows[0]) : null
}

export async function setLeadStatus(
  id: string,
  status: OutreachLeadStatus,
): Promise<void> {
  await query(
    `UPDATE outreach_leads SET status = $2, updated_at = now() WHERE id = $1`,
    [id, status],
  )
}

/** Пометить лид «написали первым»: аккаунт, время, статус contacted. */
export async function markLeadContacted(
  id: string,
  accountId: string,
): Promise<void> {
  await query(
    `UPDATE outreach_leads
        SET status = 'contacted', account_id = $2,
            contacted_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, accountId],
  )
}

export async function markLeadReplied(id: string): Promise<void> {
  await query(
    `UPDATE outreach_leads
        SET status = 'replied', replied_at = COALESCE(replied_at, now()),
            updated_at = now()
      WHERE id = $1 AND status <> 'replied'`,
    [id],
  )
}

/** Число неразобранных лидов менеджера (для бейджа навигации). */
export async function countPendingLeads(managerId: string): Promise<number> {
  const rows = await query<{ c: string }>(
    `SELECT count(*) AS c FROM outreach_leads
      WHERE assigned_manager_id = $1 AND status IN ('pending', 'assigned')`,
    [managerId],
  )
  return Number(rows[0]?.c) || 0
}

/**
 * Round-robin выбор менеджера для нового лида: активный role='manager' с
 * наименьшим числом активных (pending/assigned/contacted) лидов.
 */
export async function pickManagerForLead(): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `SELECT m.id
       FROM managers m
       LEFT JOIN (
         SELECT assigned_manager_id, count(*) AS cnt
           FROM outreach_leads
          WHERE status IN ('pending', 'assigned', 'contacted')
          GROUP BY assigned_manager_id
       ) l ON l.assigned_manager_id = m.id
      WHERE m.role = 'manager' AND m.status = 'active'
      ORDER BY COALESCE(l.cnt, 0) ASC, m.created_at ASC
      LIMIT 1`,
  )
  return rows[0]?.id ?? null
}

/* -------------------------- Тред первого касания -------------------------- */

export interface OutreachMessage {
  id: string
  leadId: string
  accountId: string | null
  direction: 'out' | 'in'
  body: string
  providerMsgId: string | null
  createdAt: string
}

interface MessageRow {
  id: string
  lead_id: string
  account_id: string | null
  direction: 'out' | 'in'
  body: string
  provider_msg_id: string | null
  created_at: string
}

export async function listLeadMessages(
  leadId: string,
): Promise<OutreachMessage[]> {
  const rows = await query<MessageRow>(
    `SELECT * FROM outreach_messages WHERE lead_id = $1 ORDER BY created_at, id`,
    [leadId],
  )
  return rows.map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    accountId: r.account_id,
    direction: r.direction,
    body: r.body,
    providerMsgId: r.provider_msg_id,
    createdAt: r.created_at,
  }))
}

export async function addLeadMessage(input: {
  leadId: string
  accountId: string | null
  direction: 'out' | 'in'
  body: string
  providerMsgId?: string | null
}): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO outreach_messages
       (lead_id, account_id, direction, body, provider_msg_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.leadId,
      input.accountId,
      input.direction,
      input.body,
      input.providerMsgId ?? null,
    ],
  )
  return rows[0].id
}
