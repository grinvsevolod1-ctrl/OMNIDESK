import { query, one } from './db.js'
import { decrypt } from './crypto.js'
import { logger } from './logger.js'

/**
 * Worker-side data access for the outreach (outbound) contour: the bought
 * Telegram account pool, its warm-up ramp, spam-block monitoring and daily/
 * hourly counters. Kept separate from `repo.ts` (the main seller pipeline) and
 * from `broadcast-repo.ts` so the outbound contour can evolve independently.
 *
 * Every account is backed by a `channels` row of kind `telegram_personal` with
 * `config.outreach = true`; the MTProto session lives in that channel's
 * secrets and is driven through the registry, exactly like god-panel personal
 * accounts. The `outreach_accounts` row carries only the outbound-specific
 * business state (warm-up stage, spam status, counters, assignment).
 */

export interface OutreachAccountRow {
  id: string
  channel_id: string | null
  api_key_id: string | null
  label: string
  phone: string | null
  status: string
  spamblock_status: string
  spamblock_until: string | null
  warmup_stage: string
  warmup_day: number
  warmup_started_at: string | null
  daily_sent: number
  daily_joins: number
  hourly_sent: number
  counters_reset_at: string | null
  last_action_at: string | null
  assigned_manager_id: string | null
}

/** Resolve the api_id / api_hash pair backing an account's pool key. */
export async function getApiCredsForAccount(
  accountId: string,
): Promise<{ apiId: number; apiHash: string } | null> {
  const row = await one<{ api_id: number; api_hash_enc: string }>(
    `SELECT k.api_id, k.api_hash_enc
       FROM outreach_accounts a
       JOIN outreach_api_keys k ON k.id = a.api_key_id
      WHERE a.id = $1`,
    [accountId],
  )
  if (!row) return null
  try {
    return { apiId: row.api_id, apiHash: decrypt(row.api_hash_enc) }
  } catch (err) {
    logger.error({ err, accountId }, 'failed to decrypt outreach api_hash')
    return null
  }
}

/**
 * Accounts eligible for a warm-up action right now: not banned/quarantined,
 * with a linked channel, ordered by least-recently-acted so the ramp spreads
 * evenly. `FOR UPDATE SKIP LOCKED` keeps concurrent ticks from grabbing the
 * same account.
 */
export async function claimWarmupCandidates(
  limit: number,
): Promise<OutreachAccountRow[]> {
  return query<OutreachAccountRow>(
    `SELECT * FROM outreach_accounts
      WHERE status NOT IN ('banned', 'quarantined', 'logged_out', 'error')
        AND warmup_stage <> 'ready'
        AND channel_id IS NOT NULL
        AND (spamblock_status <> 'blocked')
      ORDER BY last_action_at ASC NULLS FIRST
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  )
}

/** Accounts due for a periodic @SpamBot check. */
export async function claimSpamcheckCandidates(
  staleMinutes: number,
  limit: number,
): Promise<OutreachAccountRow[]> {
  return query<OutreachAccountRow>(
    `SELECT * FROM outreach_accounts
      WHERE status NOT IN ('banned', 'quarantined', 'logged_out')
        AND channel_id IS NOT NULL
        AND (
          spamblock_checked_at IS NULL
          OR spamblock_checked_at < now() - ($1 || ' minutes')::interval
        )
      ORDER BY spamblock_checked_at ASC NULLS FIRST
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    [String(staleMinutes), limit],
  )
}

export async function markAccountAction(accountId: string): Promise<void> {
  await query(
    `UPDATE outreach_accounts
        SET last_action_at = now(), updated_at = now()
      WHERE id = $1`,
    [accountId],
  )
}

export async function bumpWarmupDay(
  accountId: string,
  day: number,
  stage: string,
): Promise<void> {
  await query(
    `UPDATE outreach_accounts
        SET warmup_day = $2,
            warmup_stage = $3,
            warmup_started_at = COALESCE(warmup_started_at, now()),
            last_action_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [accountId, day, stage],
  )
}

export async function bumpJoins(accountId: string): Promise<void> {
  await query(
    `UPDATE outreach_accounts
        SET daily_joins = daily_joins + 1,
            last_action_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [accountId],
  )
}

export async function setSpamStatus(
  accountId: string,
  status: string,
  until: Date | null,
): Promise<void> {
  await query(
    `UPDATE outreach_accounts
        SET spamblock_status = $2,
            spamblock_until = $3,
            spamblock_checked_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [accountId, status, until],
  )
}

/**
 * Reset per-window send counters. Called by the counters cron/tick: hourly
 * resets `hourly_sent`, daily resets `daily_sent`/`daily_joins`.
 */
export async function resetHourlyCounters(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE outreach_accounts
        SET hourly_sent = 0
      WHERE hourly_sent > 0
      RETURNING id`,
  )
  return rows.length
}

export async function resetDailyCounters(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE outreach_accounts
        SET daily_sent = 0,
            daily_joins = 0,
            counters_reset_at = now()
      WHERE daily_sent > 0 OR daily_joins > 0
      RETURNING id`,
  )
  return rows.length
}

/** Read an outreach.* setting from app_settings (JSON value). */
export async function getOutreachSetting<T = unknown>(
  key: string,
): Promise<T | null> {
  const row = await one<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [key],
  )
  if (!row) return null
  return row.value as T
}

/* --------------------------- reply ingest (item 2) ------------------------ */

export interface OutreachOpenThreadRow {
  lead_id: string
  account_id: string
  channel_id: string
  target: string
  last_in_provider_msg_id: string | null
}

/**
 * Leads that were contacted (have an outbound message) and are not yet closed,
 * with the account/channel that owns the dialog and the last inbound provider
 * message id we already stored. The reply poller walks these, pulls fresh
 * history from MTProto and appends anything newer as an inbound message.
 */
export async function listOpenOutreachThreads(
  limit: number,
): Promise<OutreachOpenThreadRow[]> {
  return query<OutreachOpenThreadRow>(
    `SELECT DISTINCT ON (l.id)
            l.id                              AS lead_id,
            a.id                              AS account_id,
            a.channel_id                      AS channel_id,
            COALESCE(l.username, l.tg_user_id, l.phone) AS target,
            (
              SELECT m.provider_msg_id
                FROM outreach_messages m
               WHERE m.lead_id = l.id AND m.direction = 'in'
               ORDER BY m.created_at DESC
               LIMIT 1
            )                                 AS last_in_provider_msg_id
       FROM outreach_leads l
       JOIN outreach_accounts a ON a.id = l.account_id
      WHERE l.status IN ('contacted', 'replied')
        AND a.channel_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM outreach_messages o
           WHERE o.lead_id = l.id AND o.direction = 'out'
        )
      ORDER BY l.id, l.updated_at DESC
      LIMIT $1`,
    [limit],
  )
}

/**
 * Append an inbound reply captured from MTProto, idempotently (same provider
 * message id is never stored twice), and flip the lead to 'replied'. Returns
 * true when a NEW message was inserted.
 */
export async function ingestOutreachReply(args: {
  leadId: string
  accountId: string
  providerMsgId: string
  body: string
}): Promise<boolean> {
  const inserted = await one<{ id: string }>(
    `INSERT INTO outreach_messages
        (lead_id, account_id, direction, body, provider_msg_id)
     VALUES ($1, $2, 'in', $3, $4)
     ON CONFLICT (lead_id, provider_msg_id) WHERE provider_msg_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [args.leadId, args.accountId, args.body, args.providerMsgId],
  )
  if (!inserted) return false
  await query(
    `UPDATE outreach_leads
        SET status = CASE WHEN status = 'contacted' THEN 'replied' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [args.leadId],
  )
  return true
}

/* ------------------------ mutual warming (item 4) ------------------------- */

export interface WarmPeerRow {
  id: string
  channel_id: string
  username: string | null
}

/**
 * Ready/warming accounts that can act as safe conversation partners for mutual
 * warming: chatting inside the owned pool generates organic, low-risk activity
 * without touching real leads. Returns accounts with a resolvable @username.
 */
export async function listWarmPeers(limit: number): Promise<WarmPeerRow[]> {
  return query<WarmPeerRow>(
    `SELECT a.id, a.channel_id, c.config->>'username' AS username
       FROM outreach_accounts a
       JOIN channels c ON c.id = a.channel_id
      WHERE a.channel_id IS NOT NULL
        AND a.status NOT IN ('banned', 'quarantined', 'logged_out', 'error')
        AND a.spamblock_status <> 'blocked'
        AND c.config->>'username' IS NOT NULL
      ORDER BY random()
      LIMIT $1`,
    [limit],
  )
}
