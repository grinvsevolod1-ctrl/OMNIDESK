import { query, one } from './db.js'
import { decrypt, encrypt } from './crypto.js'

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
  /** Channel config JSON. For WhatsApp, provider:'cloud' marks Cloud API. */
  config: Record<string, unknown> | null
}

export interface JobRecord {
  id: string
  channel_id: string
  manager_id: string
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

export async function getChannel(id: string): Promise<ChannelRecord | null> {
  return one<ChannelRecord>('SELECT * FROM channels WHERE id = $1', [id])
}

export async function listLiveChannels(): Promise<ChannelRecord[]> {
  // Only Telegram runs in this worker. WhatsApp (Cloud API), VK and MAX are all
  // served by the Next.js app, so we never open a session for them here.
  return query<ChannelRecord>(
    `SELECT * FROM channels
     WHERE type = 'telegram'
       AND session_status IN ('online', 'offline', 'starting')`,
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
    'SELECT * FROM channel_secrets WHERE channel_id = $1',
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
    `SELECT p.* FROM proxies p
     JOIN channels c ON c.proxy_id = p.id
     WHERE c.id = $1`,
    [channelId],
  )
  if (!row) return null
  return rowToProxyConfig(row)
}

/** Load a proxy config directly by its id (used by the admin health check). */
export async function getProxyById(id: string): Promise<ProxyConfig | null> {
  const row = await one<ProxyRow>('SELECT * FROM proxies WHERE id = $1', [id])
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
  const rows = await query<{ id: string }>(
    `UPDATE messages m
        SET deleted_at = now(), deleted_origin = 'remote'
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND c.channel_id = $1
        AND m.provider_message_id = $2
        AND m.deleted_at IS NULL
      RETURNING m.id`,
    [channelId, providerMessageId],
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

/**
 * Resolve everything needed to re-download a message's media: which channel /
 * session owns it, the media kind/mime/name and the provider `ref` JSON. Used
 * by the worker's GET /media endpoint.
 */
export async function getMessageMedia(messageId: string): Promise<{
  channelId: string
  channelType: 'telegram' | 'whatsapp' | 'livechat'
  mediaType: string | null
  mediaMime: string | null
  mediaName: string | null
  mediaRef: unknown
} | null> {
  const row = await one<{
    channel_id: string
    type: 'telegram' | 'whatsapp' | 'livechat'
    media_type: string | null
    media_mime: string | null
    media_name: string | null
    media_ref: unknown
  }>(
    `SELECT c.channel_id, ch.type,
            m.media_type, m.media_mime, m.media_name, m.media_ref
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1`,
    [messageId],
  )
  if (!row) return null
  return {
    channelId: row.channel_id,
    channelType: row.type,
    mediaType: row.media_type,
    mediaMime: row.media_mime,
    mediaName: row.media_name,
    // pg returns jsonb already parsed; pass through as-is.
    mediaRef: row.media_ref,
  }
}

/* --------------------- Durable media + edit history -------------------- */

/**
 * Persist the raw media bytes of a message into Postgres (bytea) and point the
 * message at the stored blob, so the file survives the contact later deleting
 * or editing the original on their side. Idempotent: if the message already has
 * a stored blob we skip (a replay never duplicates bytes). Returns the blob id
 * or null when nothing was stored (e.g. row already had one).
 */
export async function storeMessageMediaBytes(
  messageId: string,
  bytes: Buffer,
  mime: string | null,
  name: string | null,
): Promise<string | null> {
  // Skip when this message already has stored bytes (idempotent on replays).
  const existing = await one<{ media_blob_id: string | null }>(
    `SELECT media_blob_id FROM messages WHERE id = $1`,
    [messageId],
  )
  if (!existing) return null
  if (existing.media_blob_id) return existing.media_blob_id

  const blob = await one<{ id: string }>(
    `INSERT INTO media_blobs (bytes, mime, name, byte_size)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [bytes, mime, name, bytes.byteLength],
  )
  if (!blob) return null
  await query(`UPDATE messages SET media_blob_id = $2 WHERE id = $1`, [
    messageId,
    blob.id,
  ])
  return blob.id
}

/** True when a message still needs its media bytes stored (blob missing). */
export async function messageNeedsMediaBytes(
  messageId: string,
): Promise<boolean> {
  const row = await one<{ media_type: string | null; media_blob_id: string | null }>(
    `SELECT media_type, media_blob_id FROM messages WHERE id = $1`,
    [messageId],
  )
  return Boolean(row && row.media_type && !row.media_blob_id)
}

/** Stored media bytes for a message (from its current blob), or null. */
export async function getStoredMediaBytes(
  messageId: string,
): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  const row = await one<{ bytes: Buffer; mime: string | null; name: string | null }>(
    `SELECT b.bytes, b.mime, b.name
       FROM messages m
       JOIN media_blobs b ON b.id = m.media_blob_id
      WHERE m.id = $1`,
    [messageId],
  )
  if (!row) return null
  return { bytes: Buffer.from(row.bytes), mime: row.mime, name: row.name }
}

/** Stored media bytes for a specific edit-history version, or null. */
export async function getStoredEditMediaBytes(
  editId: string,
): Promise<{ bytes: Buffer; mime: string | null; name: string | null } | null> {
  const row = await one<{ bytes: Buffer; mime: string | null; name: string | null }>(
    `SELECT b.bytes, b.mime, b.name
       FROM message_edits e
       JOIN media_blobs b ON b.id = e.media_blob_id
      WHERE e.id = $1`,
    [editId],
  )
  if (!row) return null
  return { bytes: Buffer.from(row.bytes), mime: row.mime, name: row.name }
}

/**
 * Record an edit to an inbound message identified by its provider id. Snapshots
 * the CURRENT stored version into message_edits (append-only history) and then
 * overwrites the live row with the new content. No-op when the content is
 * unchanged (Telegram re-sends edit updates for reactions/views too). Returns
 * the message id + whether media changed, so the caller can store new bytes.
 */
export async function recordMessageEditByProviderId(
  channelId: string,
  providerMessageId: string,
  next: {
    body: string
    mediaType?: string | null
    mediaMime?: string | null
    mediaName?: string | null
  },
): Promise<{ messageId: string; mediaChanged: boolean } | null> {
  const row = await one<{
    id: string
    body: string
    author: string
    media_type: string | null
    media_mime: string | null
    media_name: string | null
    media_blob_id: string | null
    edit_count: number
  }>(
    `SELECT m.id, m.body, m.author, m.media_type, m.media_mime, m.media_name,
            m.media_blob_id, m.edit_count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1 AND m.provider_message_id = $2
      LIMIT 1`,
    [channelId, providerMessageId],
  )
  if (!row) return null

  const nextType = next.mediaType ?? row.media_type
  const mediaChanged = (next.mediaType ?? null) !== (row.media_type ?? null)
  // Nothing actually changed (text identical, media kind identical): ignore.
  if (row.body === next.body && !mediaChanged) {
    return { messageId: row.id, mediaChanged: false }
  }

  const nextVersion = (row.edit_count ?? 0) + 1
  // Snapshot the version we're about to overwrite (keeps its media blob ref, so
  // the old photo/video is still viewable from history).
  await query(
    `INSERT INTO message_edits
       (message_id, version, body, media_type, media_mime, media_name, media_blob_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (message_id, version) DO NOTHING`,
    [
      row.id,
      nextVersion,
      row.body,
      row.media_type,
      row.media_mime,
      row.media_name,
      row.media_blob_id,
    ],
  )

  // Overwrite the live row. When media changed, drop the old blob pointer so the
  // caller can attach freshly downloaded bytes (the old blob stays referenced by
  // the history row above, so nothing is lost).
  await query(
    `UPDATE messages
        SET body = $2,
            media_type = $3, media_mime = $4, media_name = $5,
            media_blob_id = CASE WHEN $6 THEN NULL ELSE media_blob_id END,
            edited_at = now(),
            edit_count = $7
      WHERE id = $1`,
    [
      row.id,
      next.body,
      nextType,
      mediaChanged ? (next.mediaMime ?? null) : row.media_mime,
      mediaChanged ? (next.mediaName ?? null) : row.media_name,
      mediaChanged,
      nextVersion,
    ],
  )
  return { messageId: row.id, mediaChanged }
}

/* ------------------------------ Autopilot ----------------------------- */

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

/* ------------------------- AI manager-assistant ------------------------- */

/** Shared AI-assistant config (singleton row) + distilled playbook. */
export interface AiAssistConfig {
  enabled: boolean
  tone: string
  persona: string
  playbook: string[]
}

/** One correction lesson in the shape the pure brain expects. */
export interface AiAssistLessonLite {
  situation: string
  corrected: string
  note: string
}

/** Read the singleton AI-assist settings. Missing row → disabled defaults. */
export async function getAiAssistConfig(): Promise<AiAssistConfig> {
  const row = await one<{
    enabled: boolean
    tone: string
    persona: string
    playbook: unknown
  }>(
    `SELECT enabled, tone, persona, playbook
       FROM ai_assist_settings WHERE id = true`,
  )
  return {
    enabled: !!row?.enabled,
    tone: row?.tone ?? 'professional',
    persona: row?.persona ?? '',
    playbook: Array.isArray(row?.playbook) ? (row!.playbook as string[]) : [],
  }
}

/** Most recent correction lessons for prompt injection. */
export async function listAiLessons(
  limit = 12,
): Promise<AiAssistLessonLite[]> {
  return query<AiAssistLessonLite>(
    `SELECT situation, corrected, note
       FROM ai_assist_lessons
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(50, limit))],
  )
}

/**
 * Strict manual corrections rendered as always-inject rule strings (newest
 * first). Kept in sync with lib/data/ai-assist.ts#listManualCorrectionRules so
 * the worker's AI obeys the exact same hand-written corrections as the panel.
 * Tolerates the table being absent (pre-migration) by returning [].
 */
export async function listManualCorrectionRules(
  limit = 60,
): Promise<string[]> {
  try {
    const rows = await query<{
      context: string
      target_role: string
      target_message: string
      instruction: string
    }>(
      `SELECT context, target_role, target_message, instruction
         FROM ai_manual_corrections
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(200, limit))],
    )
    return rows.map((r) => {
      const who =
        r.target_role === 'client'
          ? 'сообщение клиента'
          : r.target_role === 'manager'
            ? 'сообщение менеджера'
            : 'твой ответ'
      const quoted = (r.target_message || '').trim()
      const ctx = (r.context || '').trim()
      const parts: string[] = []
      if (ctx) parts.push(`В ситуации:\n${ctx}`)
      if (quoted) parts.push(`Разбираем ${who}: «${quoted}».`)
      parts.push(`ПРАВИЛО: ${(r.instruction || '').trim()}`)
      return parts.join(' ')
    })
  } catch {
    return []
  }
}

/**
 * True when the AI is effectively leading THIS conversation. STRICT PER-DIALOG
 * OPT-IN (migration 065) — mirror of lib/data/ai-assist.ts#isConversationAiLed
 * so the worker and the panel agree exactly:
 *
 *   led = ai_assist_settings.enabled AND c.ai_enrolled
 *         AND NOT c.ai_paused AND NOT c.is_simulated
 */
export async function isConversationAiLed(
  conversationId: string,
): Promise<boolean> {
  const row = await one<{ led: boolean }>(
    `SELECT (s.enabled AND c.ai_enrolled AND NOT c.ai_paused
             AND NOT c.is_simulated) AS led
       FROM conversations c
       CROSS JOIN ai_assist_settings s
      WHERE c.id = $1 AND s.id = true`,
    [conversationId],
  )
  return !!row?.led
}

/**
 * The AI decided this lead is ready («Ликвид») and hands it to a human. Only
 * promotes when the lead still has its default status, pauses the AI so the
 * human takes over, and flags a pending handoff for the panel banner. Returns
 * true when it actually promoted (mirror of the panel's markAiHandoffToLiquid).
 */
export async function markAiHandoffToLiquid(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET status = 'liquid',
            status_detail = NULL,
            status_updated_at = now(),
            ai_paused = true,
            ai_handoff_pending = true,
            ai_handoff_at = now()
      WHERE id = $1
        AND COALESCE(status, 'unsubscribed') = 'unsubscribed'
      RETURNING id`,
    [conversationId],
  )
  return rows.length > 0
}

/**
 * Append one AI activity-log entry to the SHARED `ai_logs` table (migration
 * 058), so messenger/worker AI events show up in the panel "Логи" tab alongside
 * live-chat + simulator activity. Best-effort: never throws (a missing table or
 * DB hiccup must not break message ingestion). Trims opportunistically so the
 * ring buffer stays bounded.
 */
export async function logAi(input: {
  level?: 'debug' | 'info' | 'warn' | 'error'
  source?: string
  event: string
  message?: string
  conversationId?: string | null
  channelType?: string | null
  meta?: Record<string, unknown> | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO ai_logs
         (level, source, event, message, conversation_id, channel_type, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.level ?? 'info',
        input.source ?? 'worker',
        input.event,
        (input.message ?? '').slice(0, 4000),
        input.conversationId ?? null,
        input.channelType ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
      ],
    )
    if (Math.random() < 0.04) {
      await query(
        `DELETE FROM ai_logs
          WHERE id <= (
            SELECT id FROM ai_logs ORDER BY id DESC OFFSET 1500 LIMIT 1
          )`,
      )
    }
  } catch {
    // Diagnostics must never break the observed path.
  }
}

/** Recent turns of a conversation, oldest → newest, for the AI prompt. */
export async function getConversationHistoryForAi(
  conversationId: string,
  limit = 16,
): Promise<Array<{ role: 'client' | 'manager'; body: string }>> {
  // Include media-only turns (empty body) so the AI knows a sticker/photo/voice
  // message occurred instead of silently dropping it from the thread context.
  //
  // Enrollment cutoff (mirror of the panel): only feed the brain messages from
  // the moment the dialog was enrolled onward, so enrolling a pre-existing
  // thread never makes the AI replay old backlog or drift onto a stale topic.
  const rows = await query<{
  direction: 'in' | 'out'
  body: string
  media_type: string | null
  }>(
  `SELECT m.direction, m.body, m.media_type
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  LEFT JOIN messages cut ON cut.id = c.ai_enrolled_from_message_id
  WHERE m.conversation_id = $1
  AND m.deleted_at IS NULL
  AND (m.body <> '' OR m.media_type IS NOT NULL)
  AND (cut.created_at IS NULL OR m.created_at >= cut.created_at)
  ORDER BY m.created_at DESC
  LIMIT $2`,
  [conversationId, Math.max(1, Math.min(50, limit))],
  )
  return rows
    .reverse()
    .map((r) => ({
      role: r.direction === 'in' ? 'client' : 'manager',
      body: r.body.trim() || mediaPlaceholderForAi(r.media_type),
    }))
}

/** Short human-readable stand-in for a media-only message in AI history. */
function mediaPlaceholderForAi(type: string | null): string {
  switch (type) {
    case 'image':
      return '[фото]'
    case 'video':
    case 'video_note':
      return '[видео]'
    case 'audio':
      return '[аудио]'
    case 'voice':
      return '[голосовое сообщение]'
    case 'sticker':
      return '[стикер]'
    case 'document':
      return '[документ]'
    default:
      return '[вложение]'
  }
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
