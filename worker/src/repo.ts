import { query, one } from './db.js'
import { decrypt, encrypt } from './crypto.js'
import { embedText, toVectorLiteral } from '../../lib/ai/manager-brain.js'

export type SessionStatus =
  | 'idle'
  | 'starting'
  | 'qr_pending'
  | 'code_pending'
  | 'password_pending'
  | 'online'
  | 'offline'
  | 'error'
  | 'logged_out'
  // The account is being throttled / temporarily restricted by the provider, or
  // we deliberately backed off after repeated failed reconnects to avoid
  // hammering WhatsApp/Telegram (which itself risks a ban). Distinct from
  // 'error' so the panel can show a "cooling down" state and auto-resume.
  | 'rate_limited'

export interface ChannelRecord {
  id: string
  manager_id: string
  type: 'telegram' | 'whatsapp' | 'livechat'
  name: string
  detail: string
  status: string
  session_status: SessionStatus
  phone: string | null
  proxy_id: string | null
  /**
   * Soft pause: when true the session stays connected/alive but inbound
   * messages are NOT written to the inbox. Independent of session_status.
   */
  ingest_paused: boolean
  /**
   * True after an explicit stop job. Excludes the channel from auto-revival
   * and startup restore until an explicit start/restart clears it — otherwise
   * the revival sweep would resurrect a deliberately stopped account within a
   * minute (offline + saved session is exactly what it looks for).
   */
  manually_stopped: boolean
  /** Channel config JSON. For WhatsApp, provider:'cloud' marks Cloud API. */
  config: Record<string, unknown> | null
}

export interface JobRecord {
  id: string
  channel_id: string
  /** Null for system/admin-initiated jobs (e.g. God-panel kick). */
  manager_id: string | null
  action: string
  payload: Record<string, unknown>
  status: string
}

export interface ProxyConfig {
  kind: 'socks5' | 'http' | 'mtproto'
  host: string
  port: number
  username?: string
  password?: string
  secret?: string
}

/* ----------------------------- Settings ----------------------------- */

/**
 * Whether Telegram "exclusive session" enforcement is enabled (default ON).
 * Read from the shared `app_settings` table so the God-panel toggle in the
 * Next.js app and the worker agree on the same source of truth. Any error /
 * missing row / unexpected shape falls back to ON — the safe default is to keep
 * the account under our exclusive control.
 */
export async function getTelegramExclusiveSetting(): Promise<boolean> {
  try {
    const row = await one<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'telegram_exclusive_session'`,
    )
    const v = row?.value
    if (v === undefined || v === null) return true
    if (typeof v === 'boolean') return v
    if (typeof v === 'object' && 'enabled' in (v as object)) {
      return Boolean((v as { enabled?: unknown }).enabled)
    }
    return true
  } catch {
    return true
  }
}

/* ------------------------------- Jobs ------------------------------- */

/** Atomically claim a single queued job (skip locked for concurrency safety). */
export async function claimJob(jobId: string): Promise<JobRecord | null> {
  const row = await one<JobRecord>(
    `UPDATE channel_jobs
       SET status = 'running', updated_at = now()
     WHERE id = $1 AND status = 'queued'
     RETURNING id, channel_id, manager_id, action, payload, status`,
    [jobId],
  )
  return row
}

/** Claim any leftover queued jobs on startup (in case NOTIFY was missed). */
export async function claimNextQueued(): Promise<JobRecord | null> {
  return one<JobRecord>(
    `UPDATE channel_jobs
       SET status = 'running', updated_at = now()
     WHERE id = (
       SELECT id FROM channel_jobs
       WHERE status = 'queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, channel_id, manager_id, action, payload, status`,
  )
}

/**
 * Recover channel jobs orphaned in 'running' by a worker crash/redeploy.
 *
 * The per-channel serializer lives in worker memory, so after a restart NO
 * 'running' job is actually executing — but without this sweep they would sit
 * in 'running' forever: the panel keeps polling a result that never comes, and
 * (worse) listRevivableChannels / delivery recovery skip the channel because a
 * start/send job "is running", permanently blocking auto-revival for it.
 *
 * `olderThanMinutes` guards live claims: at startup 0 is safe (nothing has
 * been claimed by this process yet), while the periodic safety sweep uses a
 * threshold far above any legitimate job duration (jobs never run for tens of
 * minutes — history sync is backgrounded, not awaited inside the job).
 */
export async function recoverStuckChannelJobs(
  olderThanMinutes: number,
): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE channel_jobs
       SET status = 'error',
           last_error = 'Worker restarted while the job was running',
           updated_at = now()
     WHERE status = 'running'
       AND updated_at < now() - make_interval(mins => $1)
     RETURNING id`,
    [olderThanMinutes],
  )
  return rows.length
}

/**
 * Retention: purge finished jobs older than the window. Without this the
 * table grows forever — and voice-note jobs carry the FULL audio as base64 in
 * their payload (~0.4 MB each), so "forever" gets expensive fast. 7 days keeps
 * plenty of debugging history.
 */
export async function purgeFinishedChannelJobs(days = 7): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM channel_jobs
      WHERE status IN ('done', 'error')
        AND updated_at < now() - make_interval(days => $1)
      RETURNING id`,
    [days],
  )
  return rows.length
}

export async function finishJob(
  jobId: string,
  ok: boolean,
  result: Record<string, unknown> | null,
  error: string | null,
): Promise<void> {
  await query(
    `UPDATE channel_jobs
       SET status = $2, result = $3, last_error = $4, updated_at = now()
     WHERE id = $1`,
    [jobId, ok ? 'done' : 'error', result ? JSON.stringify(result) : null, error],
  )
}

/* ----------------------------- Channels ----------------------------- */

// Explicit column list mirroring ChannelRecord. Selecting these instead of `*`
// keeps the query in lockstep with the type and stops a future column addition
// from silently widening every channel read the worker performs.
const CHANNEL_COLUMNS =
  'id, manager_id, type, name, detail, status, session_status, phone, proxy_id, ingest_paused, manually_stopped, config'

export async function getChannel(id: string): Promise<ChannelRecord | null> {
  return one<ChannelRecord>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = $1`,
    [id],
  )
}

export async function listLiveChannels(): Promise<ChannelRecord[]> {
  // Only Telegram runs in this worker. WhatsApp (Cloud API), VK and MAX are all
  // served by the Next.js app, so we never open a session for them here.
  // Manually stopped channels stay stopped across worker restarts.
  return query<ChannelRecord>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels
     WHERE type = 'telegram'
       AND session_status IN ('online', 'offline', 'starting')
       AND NOT manually_stopped`,
  )
}

/**
 * Telegram channels eligible for AUTOMATIC revival: degraded (offline/error)
 * but with a SAVED session string — meaning a plain reconnect is enough, no
 * login interaction. Channels without a stored session are excluded on
 * purpose: "reviving" those would begin a fresh phone-code login and spam the
 * account owner with SMS. `logged_out` (authorization revoked — a human must
 * re-login) and `rate_limited` (must wait out the flood window) are also
 * intentionally NOT revivable. Channels with a queued/running start job are
 * skipped so the sweep never races an admin-initiated reconnect.
 */
export async function listRevivableChannels(): Promise<ChannelRecord[]> {
  return query<ChannelRecord>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels
     WHERE type = 'telegram'
       AND session_status IN ('offline', 'error')
       AND NOT manually_stopped
       AND EXISTS (
         SELECT 1 FROM channel_secrets s
          WHERE s.channel_id = channels.id AND s.tg_session_enc IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM channel_jobs j
          WHERE j.channel_id = channels.id
            AND j.action IN ('start', 'start_qr', 'restart')
            AND j.status IN ('queued', 'running')
       )`,
  )
}

export async function setSession(
  channelId: string,
  sessionStatus: SessionStatus,
  opts: { lastError?: string | null; markConnected?: boolean } = {},
): Promise<void> {
  const status =
    sessionStatus === 'online'
      ? 'connected'
      : sessionStatus === 'error' || sessionStatus === 'rate_limited'
        ? 'error'
        : sessionStatus === 'logged_out' || sessionStatus === 'offline'
          ? 'disconnected'
          : 'pending'
  await query(
    `UPDATE channels
       SET session_status = $2,
           status = $3,
           last_error = $4,
           last_checked_at = now(),
           connected_at = CASE WHEN $5 THEN now() ELSE connected_at END
     WHERE id = $1`,
    [
      channelId,
      sessionStatus,
      status,
      opts.lastError ?? null,
      opts.markConnected ?? sessionStatus === 'online',
    ],
  )
}

/**
 * Toggle the manual-stop flag. Set by 'stop' jobs, cleared by explicit
 * start/restart jobs. See ChannelRecord.manually_stopped.
 */
export async function setManuallyStopped(
  channelId: string,
  stopped: boolean,
): Promise<void> {
  await query(`UPDATE channels SET manually_stopped = $2 WHERE id = $1`, [
    channelId,
    stopped,
  ])
}

/**
 * Toggle the soft-pause flag for a channel. The live session is left untouched
 * (still connected); only inbound persistence is gated on this flag.
 */
export async function setIngestPaused(
  channelId: string,
  paused: boolean,
): Promise<void> {
  await query(
    'UPDATE channels SET ingest_paused = $2, last_checked_at = now() WHERE id = $1',
    [channelId, paused],
  )
}

export async function setChannelDetail(
  channelId: string,
  detail: string,
): Promise<void> {
  await query('UPDATE channels SET detail = $2 WHERE id = $1', [
    channelId,
    detail,
  ])
}

/**
 * Shallow-merge keys into the channel's JSONB config. Used to record where
 * Telegram actually delivered the login code (`codeDelivery`: 'app' | 'sms')
 * so the UI can tell the manager whether to look in the Telegram app or in SMS.
 */
export async function mergeChannelConfig(
  channelId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE channels SET config = COALESCE(config, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [channelId, JSON.stringify(patch)],
  )
}

/* ------------------------------ Secrets ----------------------------- */

interface SecretRow {
  channel_id: string
  tg_session_enc: string | null
  wa_state_enc: string | null
  token_enc: string | null
}

export async function getTgSession(channelId: string): Promise<string> {
  const row = await one<SecretRow>(
    `SELECT channel_id, tg_session_enc, wa_state_enc, token_enc
       FROM channel_secrets WHERE channel_id = $1`,
    [channelId],
  )
  if (!row?.tg_session_enc) return ''
  return decrypt(row.tg_session_enc)
}

export async function saveTgSession(
  channelId: string,
  session: string,
): Promise<void> {
  const enc = encrypt(session)
  await query(
    `INSERT INTO channel_secrets (channel_id, tg_session_enc, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (channel_id)
     DO UPDATE SET tg_session_enc = $2, updated_at = now()`,
    [channelId, enc],
  )
}

export async function clearSecrets(channelId: string): Promise<void> {
  await query('DELETE FROM channel_secrets WHERE channel_id = $1', [channelId])
}

/* ------------------------------ Proxies ----------------------------- */

interface ProxyRow {
  id: string
  kind: 'socks5' | 'http' | 'mtproto'
  host: string
  port: number
  username_enc: string | null
  password_enc: string | null
  secret_enc: string | null
}

// Explicit column list mirroring ProxyRow. The `alias` param lets it serve both
// the bare `FROM proxies` read and the joined `FROM proxies p` read below.
function proxyCols(alias = ''): string {
  const p = alias ? `${alias}.` : ''
  return `${p}id, ${p}kind, ${p}host, ${p}port, ${p}username_enc, ${p}password_enc, ${p}secret_enc`
}

function rowToProxyConfig(row: ProxyRow): ProxyConfig {
  return {
    kind: row.kind,
    host: row.host,
    port: Number(row.port),
    username: row.username_enc ? decrypt(row.username_enc) : undefined,
    password: row.password_enc ? decrypt(row.password_enc) : undefined,
    secret: row.secret_enc ? decrypt(row.secret_enc) : undefined,
  }
}

export async function getProxyForChannel(
  channelId: string,
): Promise<ProxyConfig | null> {
  const row = await one<ProxyRow>(
    `SELECT ${proxyCols('p')} FROM proxies p
     JOIN channels c ON c.proxy_id = p.id
     WHERE c.id = $1`,
    [channelId],
  )
  if (!row) return null
  return rowToProxyConfig(row)
}

/** Load a proxy config directly by its id (used by the admin health check). */
export async function getProxyById(id: string): Promise<ProxyConfig | null> {
  const row = await one<ProxyRow>(
    `SELECT ${proxyCols()} FROM proxies WHERE id = $1`,
    [id],
  )
  if (!row) return null
  return rowToProxyConfig(row)
}

export async function markProxy(
  proxyId: string,
  status: 'ok' | 'error',
  error: string | null,
): Promise<void> {
  await query('UPDATE proxies SET status = $2, last_error = $3 WHERE id = $1', [
    proxyId,
    status,
    error,
  ])
}

/* --------------------- Inbound messages persistence ------------------ */

/** Outcome of an ingestInbound call, used by Autopilot to decide whether to fire. */
export interface IngestResult {
  /** Conversation the message belongs to (created or existing). */
  conversationId: string
  /**
   * Id of the message row for this ingest — the freshly inserted row, or the
   * existing row when this was a dedup replay. Null only if it couldn't be
   * resolved. Lets the caller attach stored media bytes to the exact message.
   */
  messageId: string | null
  /** True only when a NEW message row was actually written (false on a dedup). */
  wrote: boolean
  /**
   * True when this is the FIRST inbound message of a brand-new conversation —
   * i.e. the conversation was just created by this inbound. Drives the
   * "first_message" autopilot trigger.
   */
  isFirstInbound: boolean
}

/**
 * Decide who should HANDLE a new conversation, accounting for lunch breaks.
 * If the channel owner is active and available, they keep it. Otherwise route
 * to an available substitute (active, not on lunch) via the shared atomic
 * round-robin counter, mirroring the app-side applyLunchSubstitution so both
 * ingest paths behave identically. Falls back to the owner when nobody is free,
 * so we never drop a message or violate the conversations FK.
 */
async function resolveLunchManager(ownerId: string): Promise<string> {
  try {
    // Owner available? (exists, active, not on lunch)
    const owner = await one<{ id: string }>(
      `SELECT id FROM managers
        WHERE id = $1 AND status = 'active' AND on_lunch = false
        LIMIT 1`,
      [ownerId],
    )
    if (owner) return ownerId

    // Owner away — gather available substitutes, deterministically ordered.
    const subs = await query<{ id: string }>(
      `SELECT id FROM managers
        WHERE status = 'active' AND on_lunch = false AND id <> $1::uuid
        ORDER BY id ASC`,
      [ownerId],
    )
    if (subs.length === 0) return ownerId
    if (subs.length === 1) return subs[0].id

    // Atomic, shared round-robin cursor (same counter the app side uses).
    const rows = await query<{ n: string | number }>(
      `INSERT INTO offhours_counters (name, n)
         VALUES ('lunch_substitute', 1)
       ON CONFLICT (name)
         DO UPDATE SET n = offhours_counters.n + 1
       RETURNING n`,
    )
    const n = Number(rows[0]?.n ?? 1)
    return subs[(n - 1) % subs.length].id
  } catch (err) {
    // If migration 034 (on_lunch) isn't applied yet, never break ingestion —
    // just keep the channel owner as the handler.
    console.error('[worker] resolveLunchManager failed (migration 034?):', err)
    return ownerId
  }
}

/**
 * Persist an inbound message, creating/updating its conversation. The realtime
 * NOTIFY triggers fire automatically so the panel pushes it to the browser.
 */
export async function ingestInbound(input: {
  channelId: string
  managerId: string
  channelType: 'telegram' | 'whatsapp' | 'livechat'
  contactName: string
  contactHandle: string
  /**
   * Public @username of the contact (without the leading '@'), when they have
   * one. Stored separately from the addressing handle so the panel can show it
   * next to the display name. Omit/null when unknown.
   */
  contactUsername?: string | null
  body: string
  /**
   * Message direction. Defaults to 'in' (a message FROM the contact). Pass
   * 'out' for messages the operator sent from their own linked device (e.g.
   * WhatsApp `fromMe`) so the panel mirrors both sides of the conversation.
   * Outbound messages never bump the unread counter.
   */
  direction?: 'in' | 'out'
  /**
   * Display name for the message author. Defaults to contactName for inbound
   * and 'You' for outbound, so operator-sent messages aren't labelled with the
   * contact's name.
   */
  author?: string
  /**
   * Stable provider-side message id (e.g. WhatsApp m.key.id). When present the
   * insert is de-duplicated, so the same message arriving live AND via history
   * replay (or after a relink) is stored only once.
   */
  providerMessageId?: string | null
  /**
   * Real message timestamp. Defaults to now(). History-imported messages MUST
   * pass their original time so the thread keeps chronological order.
   */
  createdAt?: Date
  /**
   * Whether this message should bump the unread badge. Defaults to true for
   * inbound. History import passes false so backfilling old chats doesn't light
   * up every conversation as unread.
   */
  countUnread?: boolean
  /**
   * Optional media descriptor. When the message carries media we record its
   * kind (sticker/voice/video_note/…), MIME, file name and a small JSON `ref`
   * that lets the worker re-download the bytes on demand. No binary is stored.
   */
  mediaType?: string | null
  mediaMime?: string | null
  mediaName?: string | null
  mediaRef?: unknown
  /** True when this outbound was generated by Autopilot (for rate caps/badging). */
  isAutopilot?: boolean
}): Promise<IngestResult> {
  const direction = input.direction ?? 'in'
  // Normalise the username: strip a leading '@' and blank → null, so storage is
  // consistent regardless of how the caller passes it.
  const contactUsername = input.contactUsername?.replace(/^@/, '').trim() || null
  const createdAt = input.createdAt ?? new Date()
  const countUnread = input.countUnread ?? direction === 'in'
  const author = input.author ?? (direction === 'out' ? 'You' : input.contactName)
  const providerId = input.providerMessageId ?? null
  const mediaType = input.mediaType ?? null
  const mediaMime = input.mediaMime ?? null
  const mediaName = input.mediaName ?? null
  const mediaRef =
    input.mediaRef === undefined || input.mediaRef === null
      ? null
      : JSON.stringify(input.mediaRef)

  // find existing open conversation for this contact on this channel
  const existing = await one<{ id: string }>(
    `SELECT id FROM conversations
     WHERE channel_id = $1 AND contact_handle = $2
     ORDER BY last_message_at DESC LIMIT 1`,
    [input.channelId, input.contactHandle],
  )

  let conversationId: string
  let conversationExisted: boolean
  if (existing) {
    conversationId = existing.id
    conversationExisted = true
  } else {
    // Route a NEW conversation away from a manager who is on lunch to an
    // available substitute (round-robin). Existing conversations are reused
    // above and keep their assigned manager, so this only affects new ones.
    const handlerId = await resolveLunchManager(input.managerId)
    const created = await one<{ id: string }>(
      `INSERT INTO conversations
         (channel_id, manager_id, channel_type, contact_name, contact_handle, contact_username, last_message, last_message_at, unread)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.channelId,
        handlerId,
        input.channelType,
        input.contactName,
        input.contactHandle,
        contactUsername,
        input.body,
        createdAt,
        countUnread ? 1 : 0,
      ],
    )
    conversationId = created!.id
    conversationExisted = false
  }

  // Insert the message, de-duplicating on the stable provider id when present.
  // RETURNING tells us whether a row was actually written: on a duplicate the
  // ON CONFLICT path returns nothing, so we must NOT touch the conversation
  // preview/unread again (otherwise replays would inflate the counters).
  const inserted = await one<{ id: string }>(
    `INSERT INTO messages
       (conversation_id, direction, body, author, created_at, provider_message_id,
        media_type, media_mime, media_name, media_ref, is_autopilot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (conversation_id, provider_message_id)
       WHERE provider_message_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      conversationId,
      direction,
      input.body,
      author,
      createdAt,
      providerId,
      mediaType,
      mediaMime,
      mediaName,
      mediaRef,
      input.isAutopilot ?? false,
    ],
  )

  // Duplicate of an already-stored message on an existing conversation: stop
  // updating counters, but still resolve the existing message id so the caller
  // can back-fill stored media bytes for a row that predates media storage.
  if (!inserted && conversationExisted) {
    let existingMessageId: string | null = null
    if (providerId) {
      const row = await one<{ id: string }>(
        `SELECT id FROM messages
          WHERE conversation_id = $1 AND provider_message_id = $2
          LIMIT 1`,
        [conversationId, providerId],
      )
      existingMessageId = row?.id ?? null
    }
    return {
      conversationId,
      messageId: existingMessageId,
      wrote: false,
      isFirstInbound: false,
    }
  }

  // Refresh the conversation only for an existing thread (a freshly created one
  // was already seeded above). The preview only moves forward in time, so an
  // out-of-order history message never clobbers a newer live preview.
  if (conversationExisted) {
    await query(
      `UPDATE conversations
         SET contact_name = CASE WHEN $4 THEN $5 ELSE contact_name END,
             contact_username = COALESCE($7, contact_username),
             last_message = CASE WHEN $2 >= last_message_at THEN $3 ELSE last_message END,
             last_message_at = GREATEST(last_message_at, $2),
             unread = unread + CASE WHEN $6 THEN 1 ELSE 0 END
       WHERE id = $1`,
      [
        conversationId,
        createdAt,
        input.body,
        // Only refresh the title from inbound messages whose name isn't just the
        // raw handle (avoids overwriting a real name with a phone number).
        direction === 'in' && input.contactName !== input.contactHandle,
        input.contactName,
        countUnread,
        // Keep the last known username; only overwrite when we actually have one.
        contactUsername,
      ],
    )
  }

  // Manual human takeover from the operator's own device: a real outbound
  // (mirrored fromMe message) that we did NOT generate ourselves hands the
  // conversation back to the human, so PAUSE AI-lead for this thread (global-
  // lead opt-out). Autopilot/AI sends carry is_autopilot=true and must NOT
  // pause it. Only stamp a freshly written row (skip replays) on an existing
  // thread. The legacy flag is cleared too so old/new readers agree.
  if (
    inserted &&
    conversationExisted &&
    direction === 'out' &&
    input.isAutopilot !== true
  ) {
    await query(
      `UPDATE conversations
          SET ai_paused = true, ai_autopilot_enabled = false
        WHERE id = $1 AND ai_paused = false`,
      [conversationId],
    )
  }

  // A first inbound is one that just created the conversation with an inbound
  // message (not an operator's own fromMe echo, not a history backfill).
  return {
    conversationId,
    messageId: inserted?.id ?? null,
    wrote: !!inserted,
    isFirstInbound: !conversationExisted && direction === 'in',
  }
}

/**
 * Upsert a conversation from a synced chat/dialog (Telegram history import).
 *
 * Unlike ingestInbound this is idempotent across reconnects: it keys on
 * (channel_id, contact_handle), refreshes the preview + unread count, and only
 * seeds a single "last message" row when the conversation is first created. It
 * never keeps appending the same history message on every restart.
 */
export async function upsertDialog(input: {
  channelId: string
  managerId: string
  channelType: 'telegram' | 'whatsapp'
  contactName: string
  contactHandle: string
  /** Public @username (without leading '@'), when known. */
  contactUsername?: string | null
  lastMessage: string
  lastMessageAt: Date
  unread: number
  lastFromMe: boolean
}): Promise<void> {
  const contactUsername = input.contactUsername?.replace(/^@/, '').trim() || null
  const existing = await one<{ id: string }>(
    `SELECT id FROM conversations
       WHERE channel_id = $1 AND contact_handle = $2
       LIMIT 1`,
    [input.channelId, input.contactHandle],
  )

  if (existing) {
    await query(
      `UPDATE conversations
         SET contact_name = $2,
             contact_username = COALESCE($6, contact_username),
             last_message = $3,
             last_message_at = $4,
             unread = $5
       WHERE id = $1`,
      [
        existing.id,
        input.contactName,
        input.lastMessage,
        input.lastMessageAt,
        input.unread,
        contactUsername,
      ],
    )
    return
  }

  const created = await one<{ id: string }>(
    `INSERT INTO conversations
       (channel_id, manager_id, channel_type, contact_name, contact_handle, contact_username, last_message, last_message_at, unread)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.channelId,
      input.managerId,
      input.channelType,
      input.contactName,
      input.contactHandle,
      contactUsername,
      input.lastMessage,
      input.lastMessageAt,
      input.unread,
    ],
  )

  // Seed the thread with the last known message so opening the conversation
  // isn't blank. Direction reflects who sent that last message.
  await query(
    `INSERT INTO messages (conversation_id, direction, body, author, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      created!.id,
      input.lastFromMe ? 'out' : 'in',
      input.lastMessage,
      input.lastFromMe ? 'You' : input.contactName,
      input.lastMessageAt,
    ],
  )
}

/**
 * Backfill the provider/Telegram message id onto an existing message row (the
 * panel's optimistically-inserted outbound message). Lets the panel later
 * delete / forward / react to a message we sent.
 */
export async function setMessageProviderId(
  messageId: string,
  providerMessageId: string,
): Promise<void> {
  await query(
    `UPDATE messages SET provider_message_id = $2
       WHERE id = $1 AND provider_message_id IS NULL`,
    [messageId, providerMessageId],
  )
}

/**
 * Outbound messages that never reached Telegram because the session was down
 * when the manager hit "send" — the post-reconnect delivery-recovery sweep
 * resends exactly these. A message qualifies when:
 *
 *  - it has NO provider_message_id (a confirmed send always backfills one), AND
 *  - it either failed with the stable OFFLINE marker, or still sits in the
 *    optimistic 'sent' state 2+ minutes later (its job was lost before it ran);
 *  - it is plain text (media resends could duplicate large uploads), recent
 *    (24h window — a stale resend would confuse the contact), and has NO
 *    still-queued/running send job (the queue drain will deliver those itself,
 *    so touching them here would double-send).
 */
export async function listRecoverableOutbound(
  channelId: string,
  offlineReason: string,
): Promise<Array<{ id: string; body: string; contactHandle: string }>> {
  const rows = await query<{
    id: string
    body: string
    contact_handle: string
  }>(
    `SELECT m.id, m.body, c.contact_handle
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1
        AND m.direction = 'out'
        AND m.provider_message_id IS NULL
        AND m.deleted_at IS NULL
        AND m.media_type IS NULL
        AND m.body <> ''
        AND m.created_at > now() - interval '24 hours'
        AND m.created_at < now() - interval '2 minutes'
        AND (
          (m.status = 'failed' AND m.error_reason = $2)
          OR m.status = 'sent'
        )
        AND NOT EXISTS (
          SELECT 1 FROM channel_jobs j
           WHERE j.channel_id = c.channel_id
             AND j.action = 'send_message'
             -- queued/running: the drain will deliver it; done: it WAS
             -- delivered (even if the provider-id backfill failed), so a
             -- resend here would duplicate the message for the contact.
             AND j.status IN ('queued', 'running', 'done')
             AND j.payload->>'messageId' = m.id::text
        )
      ORDER BY m.created_at ASC
      LIMIT 30`,
    [channelId, offlineReason],
  )
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    contactHandle: r.contact_handle,
  }))
}

/* ----------------------- Telegram peer cache ------------------------- */

export type TelegramPeerKind = 'user' | 'channel' | 'chat'

export interface TelegramPeerRecord {
  kind: TelegramPeerKind
  peerId: string
  accessHash: string | null
}

/**
 * Persist a Telegram peer's access_hash so we can reconstruct an input peer
 * after a restart without relying on GramJS's volatile entity cache. Upserts on
 * (channel_id, handle); a null access_hash (basic groups) is allowed.
 */
export async function saveTelegramPeer(
  channelId: string,
  handle: string,
  peer: TelegramPeerRecord,
): Promise<void> {
  await query(
    `INSERT INTO telegram_peers (channel_id, handle, kind, peer_id, access_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (channel_id, handle) DO UPDATE
       SET kind = EXCLUDED.kind,
           peer_id = EXCLUDED.peer_id,
           access_hash = COALESCE(EXCLUDED.access_hash, telegram_peers.access_hash),
           updated_at = now()`,
    [channelId, handle, peer.kind, peer.peerId, peer.accessHash],
  )
}

/** Look up a persisted Telegram peer by its stored handle. */
export async function getTelegramPeer(
  channelId: string,
  handle: string,
): Promise<TelegramPeerRecord | null> {
  const row = await one<{
    kind: TelegramPeerKind
    peer_id: string
    access_hash: string | null
  }>(
    `SELECT kind, peer_id, access_hash FROM telegram_peers
      WHERE channel_id = $1 AND handle = $2`,
    [channelId, handle],
  )
  if (!row) return null
  return { kind: row.kind, peerId: row.peer_id, accessHash: row.access_hash }
}

/* ---------------------- Backfill watermarks ---------------------- */

/**
 * Per-chat history sync progress (see scripts/105). Lets a reconnect fetch
 * only the offline gap instead of re-paging the chat's entire history, and
 * lets an interrupted deep backfill resume where it stopped.
 */
export interface BackfillWatermark {
  newestSyncedId: number
  oldestSyncedId: number
  complete: boolean
}

export async function getBackfillWatermark(
  channelId: string,
  handle: string,
): Promise<BackfillWatermark | null> {
  const row = await one<{
    newest_synced_id: string
    oldest_synced_id: string
    complete: boolean
  }>(
    `SELECT newest_synced_id, oldest_synced_id, complete
       FROM telegram_backfill_watermarks
      WHERE channel_id = $1 AND contact_handle = $2`,
    [channelId, handle],
  )
  if (!row) return null
  return {
    newestSyncedId: Number(row.newest_synced_id),
    oldestSyncedId: Number(row.oldest_synced_id),
    complete: row.complete,
  }
}

/**
 * Monotonic upsert: newest only ever grows, oldest only ever shrinks (toward
 * the first message), complete never reverts to false. Safe to call from
 * overlapping sweeps.
 */
export async function upsertBackfillWatermark(
  channelId: string,
  handle: string,
  patch: Partial<BackfillWatermark>,
): Promise<void> {
  await query(
    `INSERT INTO telegram_backfill_watermarks
       (channel_id, contact_handle, newest_synced_id, oldest_synced_id, complete, updated_at)
     VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, 0), COALESCE($5, false), now())
     ON CONFLICT (channel_id, contact_handle) DO UPDATE
       SET newest_synced_id = GREATEST(
             telegram_backfill_watermarks.newest_synced_id,
             COALESCE($3, telegram_backfill_watermarks.newest_synced_id)
           ),
           oldest_synced_id = CASE
             WHEN $4 IS NULL THEN telegram_backfill_watermarks.oldest_synced_id
             WHEN telegram_backfill_watermarks.oldest_synced_id = 0 THEN $4
             ELSE LEAST(telegram_backfill_watermarks.oldest_synced_id, $4)
           END,
           complete = telegram_backfill_watermarks.complete OR COALESCE($5, false),
           updated_at = now()`,
    [
      channelId,
      handle,
      patch.newestSyncedId ?? null,
      patch.oldestSyncedId ?? null,
      patch.complete ?? null,
    ],
  )
}

/** Outbound delivery lifecycle, ordered. Status only ever moves forward. */
export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed'

/**
 * Advance the delivery status of a single OUTBOUND message identified by its
 * provider id within a channel. The status only moves forward (sent ->
 * delivered -> read); 'failed' may always be set. A no-op when the message is
 * unknown or already at/ahead of the target status, so duplicate provider
 * receipts are harmless.
 */
export async function setMessageStatusByProviderId(
  channelId: string,
  providerMessageId: string,
  status: MessageStatus,
  reason?: string | null,
): Promise<void> {
  // On 'failed' we also record the human-readable reason; on any forward step
  // (sent/delivered/read) we clear a stale reason so a message that ultimately
  // succeeded doesn't keep showing an old error.
  await query(
    `UPDATE messages m
        SET status = $3,
            error_reason = CASE WHEN $3 = 'failed' THEN $4 ELSE NULL END
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND c.channel_id = $1
        AND m.provider_message_id = $2
        AND m.direction = 'out'
        AND (
          $3 = 'failed'
          OR COALESCE(
               CASE m.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2
                             WHEN 'sent' THEN 1 ELSE 0 END, 0)
             < CASE $3 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2
                       WHEN 'sent' THEN 1 ELSE 0 END
        )`,
    [channelId, providerMessageId, status, reason ?? null],
  )
}

/**
 * Set the delivery status of a single message directly by its row id. Used to
 * flag a send as 'failed' when the provider rejects it, since at that point
 * there's often no provider id to match on. When `reason` is given it is stored
 * on error_reason so the panel shows WHY the send failed next to the "!" marker.
 */
export async function setMessageStatus(
  messageId: string,
  status: MessageStatus,
  reason?: string | null,
): Promise<void> {
  await query(
    `UPDATE messages
        SET status = $2,
            error_reason = CASE WHEN $2 = 'failed' THEN $3 ELSE NULL END
       WHERE id = $1 AND direction = 'out'`,
    [messageId, status, reason ?? null],
  )
}

/**
 * Mark every outbound message in a conversation as 'read' up to (and including)
 * a provider message id. Used for Telegram's "read up to max_id" outbox
 * receipts, where a single update acknowledges a whole run of our messages.
 * Only numeric provider ids (Telegram message ids) participate in the compare.
 */
export async function markOutboundReadUpTo(
  channelId: string,
  contactHandle: string,
  maxProviderId: string,
): Promise<void> {
  if (!/^\d+$/.test(maxProviderId)) return
  await query(
    `UPDATE messages m
        SET status = 'read'
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND c.channel_id = $1
        AND c.contact_handle = $2
        AND m.direction = 'out'
        AND m.provider_message_id ~ '^[0-9]+$'
        AND m.provider_message_id::bigint <= $3::bigint
        AND (m.status IS NULL OR m.status <> 'read')`,
    [channelId, contactHandle, maxProviderId],
  )
}

/**
 * Mark a message as deleted by the CONTACT (the other side revoked it). We keep
 * the original body/media intact and only stamp `deleted_at` + a 'remote'
 * origin, so the panel shows the original content with a "deleted by contact"
 * marker instead of losing it. Matched by provider message id within the
 * channel. Idempotent (only stamps a not-yet-deleted row), so duplicate
 * delete notifications are harmless. Returns the affected message ids.
 */
export async function markInboundDeletedByProviderId(
  channelId: string,
  providerMessageId: string,
): Promise<string[]> {
  return markInboundDeletedByProviderIds(channelId, [providerMessageId])
}

/**
 * Batch variant: Telegram delete updates carry an ARRAY of message ids (a
 * "clear chat" can revoke hundreds at once). One UPDATE with ANY($2) instead
 * of a query per id.
 */
export async function markInboundDeletedByProviderIds(
  channelId: string,
  providerMessageIds: string[],
): Promise<string[]> {
  if (providerMessageIds.length === 0) return []
  const rows = await query<{ id: string }>(
    `UPDATE messages m
        SET deleted_at = now(), deleted_origin = 'remote'
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND c.channel_id = $1
        AND m.provider_message_id = ANY($2)
        AND m.deleted_at IS NULL
      RETURNING m.id`,
    [channelId, providerMessageIds],
  )
  return rows.map((r) => r.id)
}

/**
 * Recent inbound provider message ids for a conversation, newest first. Used to
 * build WhatsApp read-receipt keys when the operator opens a chat so the
 * contact sees our blue ticks. Bounded so we never replay an entire thread.
 */
export async function getRecentInboundProviderIds(
  channelId: string,
  contactHandle: string,
  limit = 30,
): Promise<string[]> {
  const rows = await query<{ provider_message_id: string }>(
    `SELECT m.provider_message_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1
        AND c.contact_handle = $2
        AND m.direction = 'in'
        AND m.provider_message_id IS NOT NULL
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [channelId, contactHandle, limit],
  )
  return rows.map((r) => r.provider_message_id)
}

/** Fetch the outbound target (contact_handle) for a conversation. */
export async function getOutboundTarget(
  conversationId: string,
): Promise<{ contactHandle: string; channelId: string } | null> {
  const row = await one<{ contact_handle: string; channel_id: string }>(
    'SELECT contact_handle, channel_id FROM conversations WHERE id = $1',
    [conversationId],
  )
  if (!row) return null
  return { contactHandle: row.contact_handle, channelId: row.channel_id }
}

/* --------------------------------------------------------------------------
 * Domain re-exports. Message-media and AI/autopilot concerns were split into
 * focused sibling modules; consumers keep importing them via `repo.*`.
 * ------------------------------------------------------------------------ */
export * from './repo-media.js'
export * from './repo-ai.js'
