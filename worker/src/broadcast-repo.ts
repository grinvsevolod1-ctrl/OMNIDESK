/**
 * Worker-pool data access for group broadcasts (миграция 171).
 *
 * Mirrors lib/data/broadcast.ts but on the WORKER pool and shaped for the
 * runner: claim the next due campaign, claim the next due target with
 * FOR UPDATE SKIP LOCKED (so concurrent ticks never grab the same row), and
 * settle results with pacing / backoff timestamps.
 */
import { query, one } from './db.js'

export interface DueCampaign {
  id: string
  channelId: string
  baseText: string
  minDelaySec: number
  maxDelaySec: number
  captchaReply: string
  consecErrors: number
}

export interface ClaimedTarget {
  id: string
  campaignId: string
  rawInput: string
  resolvedPeerId: string | null
  resolvedTitle: string | null
  draftText: string
  attempts: number
}

/**
 * Campaigns that are running and whose pacing lock has elapsed. The runner
 * processes ONE target per campaign per tick so a single account never fires
 * two sends back-to-back.
 */
export async function listDueCampaigns(): Promise<DueCampaign[]> {
  return query<DueCampaign>(
    `SELECT id, channel_id AS "channelId", base_text AS "baseText",
            min_delay_sec AS "minDelaySec", max_delay_sec AS "maxDelaySec",
            captcha_reply AS "captchaReply", consec_errors AS "consecErrors"
     FROM broadcast_campaigns
     WHERE status = 'running'
       AND (not_before IS NULL OR not_before <= now())
     ORDER BY updated_at
     LIMIT 20`,
  )
}

/**
 * Claim the next actionable target for a campaign. `pending` targets that are
 * due (per-target backoff elapsed) become `joining` atomically so a second tick
 * skips them. Returns null when nothing is due.
 */
export async function claimNextTarget(
  campaignId: string,
): Promise<ClaimedTarget | null> {
  const row = await one<ClaimedTarget>(
    `UPDATE broadcast_targets
     SET status = 'joining', attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM broadcast_targets
       WHERE campaign_id = $1
         AND status = 'pending'
         AND (not_before IS NULL OR not_before <= now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, campaign_id AS "campaignId", raw_input AS "rawInput",
               resolved_peer_id AS "resolvedPeerId",
               resolved_title AS "resolvedTitle",
               draft_text AS "draftText", attempts`,
    [campaignId],
  )
  return row
}

/** Are there any targets left that will ever be actionable? */
export async function hasUnfinishedTargets(campaignId: string): Promise<boolean> {
  const row = await one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM broadcast_targets
     WHERE campaign_id = $1 AND status IN ('pending', 'joining', 'verifying', 'sending')`,
    [campaignId],
  )
  return Number(row?.n ?? '0') > 0
}

export async function setTargetStage(
  id: string,
  status: 'verifying' | 'sending',
): Promise<void> {
  await query(
    `UPDATE broadcast_targets SET status = $2, updated_at = now() WHERE id = $1`,
    [id, status],
  )
}

export async function markTargetResolved(
  id: string,
  peerId: string,
  title: string,
): Promise<void> {
  await query(
    `UPDATE broadcast_targets
     SET resolved_peer_id = $2, resolved_title = $3, updated_at = now()
     WHERE id = $1`,
    [id, peerId, title],
  )
}

export async function markTargetSent(id: string): Promise<void> {
  await query(
    `UPDATE broadcast_targets
     SET status = 'sent', error = NULL, sent_at = now(), updated_at = now()
     WHERE id = $1`,
    [id],
  )
}

/** Terminal failure or a soft "needs a human" state — no more auto retries. */
export async function markTargetStuck(
  id: string,
  status: 'failed' | 'needs_attention',
  error: string,
): Promise<void> {
  await query(
    `UPDATE broadcast_targets SET status = $2, error = $3, updated_at = now()
     WHERE id = $1`,
    [id, status, error],
  )
}

/**
 * Retryable failure: back to `pending` with a per-target `not_before` so the
 * next tick waits out the backoff instead of hammering the same group.
 */
export async function requeueTarget(
  id: string,
  backoffSec: number,
  error: string,
): Promise<void> {
  await query(
    `UPDATE broadcast_targets
     SET status = 'pending', error = $3,
         not_before = now() + ($2 || ' seconds')::interval, updated_at = now()
     WHERE id = $1`,
    [id, String(Math.max(1, Math.round(backoffSec))), error],
  )
}

/* -------------------------------- Campaigns -------------------------------- */

/** Park the whole campaign until `delaySec` from now (human-like pacing). */
export async function pushCampaignNotBefore(
  id: string,
  delaySec: number,
): Promise<void> {
  await query(
    `UPDATE broadcast_campaigns
     SET not_before = now() + ($2 || ' seconds')::interval, updated_at = now()
     WHERE id = $1`,
    [id, String(Math.max(1, Math.round(delaySec)))],
  )
}

export async function resetCampaignErrors(id: string): Promise<void> {
  await query(
    `UPDATE broadcast_campaigns
     SET consec_errors = 0, last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id],
  )
}

/** Increment the consecutive-error counter; returns the new value. */
export async function bumpCampaignErrors(
  id: string,
  error: string,
): Promise<number> {
  const row = await one<{ consec_errors: number }>(
    `UPDATE broadcast_campaigns
     SET consec_errors = consec_errors + 1, last_error = $2, updated_at = now()
     WHERE id = $1
     RETURNING consec_errors`,
    [id, error],
  )
  return row?.consec_errors ?? 0
}

export async function stopCampaign(
  id: string,
  status: 'done' | 'failed',
  error?: string,
): Promise<void> {
  await query(
    `UPDATE broadcast_campaigns
     SET status = $2, last_error = COALESCE($3, last_error), updated_at = now()
     WHERE id = $1`,
    [id, status, error ?? null],
  )
}
