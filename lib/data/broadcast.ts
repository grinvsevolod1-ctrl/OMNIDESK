/**
 * Data layer for group broadcasts sent from a personal Telegram account
 * (god-панель). Panel-pool CRUD over broadcast_campaigns / broadcast_targets
 * (миграция 171).
 *
 * ВАЖНО про инвариант приватности (AGENTS.md §4): личные аккаунты не пишут
 * переписку в Postgres. Здесь хранится ТОЛЬКО собственный исходящий контент
 * владельца (контекст + тексты), публичные хэндлы групп и статусы кампании —
 * это операционные данные рассылки, а не приватные контакты/история. Списки
 * участников и чужие сообщения не сохраняются никогда.
 */
import { query } from '../db'

export type CampaignStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'

export type TargetStatus =
  | 'pending'
  | 'joining'
  | 'verifying'
  | 'sending'
  | 'sent'
  | 'needs_attention'
  | 'failed'
  | 'skipped'

export interface BroadcastCampaign {
  id: string
  createdAt: string
  updatedAt: string
  channelId: string
  context: string
  baseText: string
  status: CampaignStatus
  minDelaySec: number
  maxDelaySec: number
  captchaReply: string
  consecErrors: number
  lastError: string | null
}

export interface BroadcastTarget {
  id: string
  campaignId: string
  rawInput: string
  resolvedPeerId: string | null
  resolvedTitle: string | null
  draftText: string
  status: TargetStatus
  error: string | null
  attempts: number
  sentAt: string | null
}

interface CampaignRow {
  id: string
  created_at: string
  updated_at: string
  channel_id: string
  context: string
  base_text: string
  status: CampaignStatus
  min_delay_sec: number
  max_delay_sec: number
  captcha_reply: string
  consec_errors: number
  last_error: string | null
}

interface TargetRow {
  id: string
  campaign_id: string
  raw_input: string
  resolved_peer_id: string | null
  resolved_title: string | null
  draft_text: string
  status: TargetStatus
  error: string | null
  attempts: number
  sent_at: string | null
}

function toCampaign(r: CampaignRow): BroadcastCampaign {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    channelId: r.channel_id,
    context: r.context,
    baseText: r.base_text,
    status: r.status,
    minDelaySec: r.min_delay_sec,
    maxDelaySec: r.max_delay_sec,
    captchaReply: r.captcha_reply,
    consecErrors: r.consec_errors,
    lastError: r.last_error,
  }
}

function toTarget(r: TargetRow): BroadcastTarget {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    rawInput: r.raw_input,
    resolvedPeerId: r.resolved_peer_id,
    resolvedTitle: r.resolved_title,
    draftText: r.draft_text,
    status: r.status,
    error: r.error,
    attempts: r.attempts,
    sentAt: r.sent_at,
  }
}

/* --------------------------------- Campaigns -------------------------------- */

/** Create a draft campaign for a personal channel with its raw group inputs. */
export async function createCampaign(input: {
  channelId: string
  context: string
  captchaReply?: string
  minDelaySec?: number
  maxDelaySec?: number
  rawInputs: string[]
}): Promise<BroadcastCampaign> {
  const rows = await query<CampaignRow>(
    `INSERT INTO broadcast_campaigns
       (channel_id, context, captcha_reply, min_delay_sec, max_delay_sec)
     VALUES ($1, $2,
             COALESCE(NULLIF($3, ''), DEFAULT),
             COALESCE($4, DEFAULT),
             COALESCE($5, DEFAULT))
     RETURNING *`,
    [
      input.channelId,
      input.context,
      input.captchaReply ?? '',
      input.minDelaySec ?? null,
      input.maxDelaySec ?? null,
    ],
  )
  const campaign = toCampaign(rows[0])

  const cleaned = dedupeInputs(input.rawInputs)
  if (cleaned.length > 0) {
    // Bulk insert every target as a single multi-row VALUES statement.
    const values: string[] = []
    const params: unknown[] = [campaign.id]
    cleaned.forEach((raw, i) => {
      values.push(`($1, $${i + 2})`)
      params.push(raw)
    })
    await query(
      `INSERT INTO broadcast_targets (campaign_id, raw_input)
       VALUES ${values.join(', ')}`,
      params,
    )
  }
  return campaign
}

export async function getCampaign(
  id: string,
): Promise<BroadcastCampaign | null> {
  const rows = await query<CampaignRow>(
    `SELECT * FROM broadcast_campaigns WHERE id = $1`,
    [id],
  )
  return rows[0] ? toCampaign(rows[0]) : null
}

/** Most recent campaign for a personal channel (the god-panel shows one). */
export async function getLatestCampaignForChannel(
  channelId: string,
): Promise<BroadcastCampaign | null> {
  const rows = await query<CampaignRow>(
    `SELECT * FROM broadcast_campaigns
     WHERE channel_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [channelId],
  )
  return rows[0] ? toCampaign(rows[0]) : null
}

export async function setCampaignBaseText(
  id: string,
  baseText: string,
): Promise<void> {
  await query(
    `UPDATE broadcast_campaigns
     SET base_text = $2, updated_at = now()
     WHERE id = $1`,
    [id, baseText],
  )
}

export async function setCampaignStatus(
  id: string,
  status: CampaignStatus,
): Promise<void> {
  // Starting/resuming clears the pacing lock and the consecutive-error counter
  // so a resumed campaign is immediately eligible and not one strike from the
  // auto-stop threshold.
  if (status === 'running') {
    await query(
      `UPDATE broadcast_campaigns
       SET status = 'running', not_before = NULL, consec_errors = 0,
           updated_at = now()
       WHERE id = $1`,
      [id],
    )
    return
  }
  await query(
    `UPDATE broadcast_campaigns
     SET status = $2, updated_at = now()
     WHERE id = $1`,
    [id, status],
  )
}

/* ---------------------------------- Targets --------------------------------- */

export async function listTargets(
  campaignId: string,
): Promise<BroadcastTarget[]> {
  const rows = await query<TargetRow>(
    `SELECT * FROM broadcast_targets
     WHERE campaign_id = $1
     ORDER BY created_at`,
    [campaignId],
  )
  return rows.map(toTarget)
}

export async function setTargetResolved(
  id: string,
  resolved: { peerId: string | null; title: string | null },
): Promise<void> {
  await query(
    `UPDATE broadcast_targets
     SET resolved_peer_id = $2, resolved_title = $3, updated_at = now()
     WHERE id = $1`,
    [id, resolved.peerId, resolved.title],
  )
}

export async function setTargetDraft(
  id: string,
  draftText: string,
): Promise<void> {
  await query(
    `UPDATE broadcast_targets
     SET draft_text = $2, updated_at = now()
     WHERE id = $1`,
    [id, draftText],
  )
}

export async function setTargetStatus(
  id: string,
  status: TargetStatus,
): Promise<void> {
  await query(
    `UPDATE broadcast_targets
     SET status = $2, updated_at = now()
     WHERE id = $1`,
    [id, status],
  )
}

export async function removeTarget(id: string): Promise<void> {
  await query(`DELETE FROM broadcast_targets WHERE id = $1`, [id])
}

/** Count targets by status for a compact progress summary in the UI. */
export async function countTargetsByStatus(
  campaignId: string,
): Promise<Record<TargetStatus, number>> {
  const rows = await query<{ status: TargetStatus; n: string }>(
    `SELECT status, COUNT(*)::text AS n
     FROM broadcast_targets
     WHERE campaign_id = $1
     GROUP BY status`,
    [campaignId],
  )
  const out: Record<TargetStatus, number> = {
    pending: 0,
    joining: 0,
    verifying: 0,
    sending: 0,
    sent: 0,
    needs_attention: 0,
    failed: 0,
    skipped: 0,
  }
  for (const r of rows) out[r.status] = Number(r.n)
  return out
}

/* --------------------------------- Helpers ---------------------------------- */

/** Trim, drop blanks, and de-duplicate raw group inputs (case-insensitive). */
export function dedupeInputs(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const trimmed = item.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}
