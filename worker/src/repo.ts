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
  type: 'telegram' | 'whatsapp' | 'livechat' | 'max'
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
  /**
   * How many times this job has been claimed (1 on first run). Caps the
   * delayed-retry loop for FLOOD_WAIT sends — see scripts/109.
   */
  attempts: number
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
       SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status = 'queued'
       AND (not_before IS NULL OR not_before <= now())
     RETURNING id, channel_id, manager_id, action, payload, status, attempts`,
    [jobId],
  )
  return row
}

/**
 * Claim any leftover queued jobs (startup + the periodic fallback drain).
 * Jobs parked for a delayed retry (not_before in the future) are invisible
 * until their time comes; the 45s fallback drain then picks them up — no
 * dedicated retry timer needed, and the schedule survives worker restarts
 * because it lives in the row, not in memory.
 */
export async function claimNextQueued(): Promise<JobRecord | null> {
  return one<JobRecord>(
    `UPDATE channel_jobs
       SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM channel_jobs
       WHERE status = 'queued'
         AND (not_before IS NULL OR not_before <= now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, channel_id, manager_id, action, payload, status, attempts`,
  )
}

/**
 * Park a job for a delayed retry: back to 'queued', invisible to claims until
 * `delaySeconds` from now. The wait reason is recorded in last_error so the
 * god-panel job view shows what the job is waiting out (typically FLOOD_WAIT).
 */
export async function rescheduleJob(
  jobId: string,
  delaySeconds: number,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE channel_jobs
       SET status = 'queued',
           not_before = now() + make_interval(secs => $2),
           last_error = $3,
           updated_at = now()
     WHERE id = $1`,
    [jobId, delaySeconds, reason],
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
  const rows = await query<{ id: string; action: string; payload: Record<string, unknown> }>(
    `UPDATE channel_jobs
       SET status = 'error',
           last_error = 'Worker restarted while the job was running',
           updated_at = now()
     WHERE status = 'running'
       AND updated_at < now() - make_interval(mins => $1)
     RETURNING id, action, payload`,
    [olderThanMinutes],
  )

  // A recovered SEND job carries an optimistic message row (inserted as
  // 'sent', confirmed later by the provider_message_id backfill) that will
  // otherwise look delivered forever — the job that would have resolved it is
  // dead. Flag still-unconfirmed ones failed with an honest reason so the
  // manager sees a retryable "!" instead of a silent maybe-never-sent.
  // (OFFLINE_SEND_REASON is NOT used on purpose: the auto-resend sweep must
  // not resend a message that MAY have reached Telegram just before the crash
  // — a human should decide, a duplicate to a client is worse than a retry
  // click.)
  const orphanedMessageIds = rows
    .filter((r) => ['send_message', 'send_voice', 'send_sticker', 'forward_message'].includes(r.action))
    .map((r) => r.payload?.messageId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (orphanedMessageIds.length > 0) {
    await query(
      `UPDATE messages
          SET status = 'failed',
              error_reason = 'Отправка прервана перезапуском воркера. Проверьте, дошло ли сообщение, и повторите при необходимости.'
        WHERE id = ANY($1)
          AND direction = 'out'
          AND status = 'sent'
          AND provider_message_id IS NULL`,
      [orphanedMessageIds],
    ).catch(() => {
      /* never let message flagging break job recovery itself */
    })
  }

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
  // Two providers hold a live socket in THIS worker: Telegram (MTProto) and
  // MAX in ACCOUNT mode (config.mode='account', unofficial WebSocket). MAX in
  // BOT mode, WhatsApp Cloud API, VK and live-chat are all served by the
  // Next.js app, so we never open a session for them here. Manually stopped
  // channels stay stopped across worker restarts.
  return query<ChannelRecord>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels
     WHERE (
             type = 'telegram'
             OR (type = 'max' AND config->>'mode' = 'account')
           )
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
  // A channel is revivable when a plain reconnect (no human login) suffices:
  // it is degraded but has the relevant saved session — tg_session_enc for
  // Telegram, max_session_enc for a MAX account. The provider/session pairing
  // is enforced per-type so a Telegram row can't be "revived" off a MAX token
  // or vice-versa. Everything else (logged_out, rate_limited, no session, or a
  // pending start job) is intentionally excluded — see the note above.
  return query<ChannelRecord>(
    `SELECT ${CHANNEL_COLUMNS} FROM channels
     WHERE session_status IN ('offline', 'error')
       AND NOT manually_stopped
       AND (
         (type = 'telegram' AND EXISTS (
            SELECT 1 FROM channel_secrets s
             WHERE s.channel_id = channels.id AND s.tg_session_enc IS NOT NULL
         ))
         OR
         (type = 'max' AND config->>'mode' = 'account' AND EXISTS (
            SELECT 1 FROM channel_secrets s
             WHERE s.channel_id = channels.id AND s.max_session_enc IS NOT NULL
         ))
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
  max_session_enc: string | null
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

/** Load the encrypted MAX userbot session token (empty string if none). */
export async function getMaxSession(channelId: string): Promise<string> {
  const row = await one<SecretRow>(
    `SELECT channel_id, tg_session_enc, wa_state_enc, token_enc, max_session_enc
       FROM channel_secrets WHERE channel_id = $1`,
    [channelId],
  )
  if (!row?.max_session_enc) return ''
  return decrypt(row.max_session_enc)
}

/** Persist the MAX userbot session token, encrypted (mirrors saveTgSession). */
export async function saveMaxSession(
  channelId: string,
  session: string,
): Promise<void> {
  const enc = encrypt(session)
  await query(
    `INSERT INTO channel_secrets (channel_id, max_session_enc, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (channel_id)
     DO UPDATE SET max_session_enc = $2, updated_at = now()`,
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
  latencyMs?: number | null,
): Promise<void> {
  // latency_ms/last_checked_at exist after scripts/108; fall back gracefully
  // for deployments that haven't applied it yet.
  try {
    await query(
      `UPDATE proxies
          SET status = $2, last_error = $3,
              latency_ms = $4, last_checked_at = now()
        WHERE id = $1`,
      [proxyId, status, error, latencyMs ?? null],
    )
  } catch {
    await query(
      'UPDATE proxies SET status = $2, last_error = $3 WHERE id = $1',
      [proxyId, status, error],
    )
  }
}

/** A proxy row enriched with id/manager/latency for the failover picker. */
export interface ProxyPickRow {
  id: string
  manager_id: string
  latency_ms: number | null
  config: ProxyConfig
}

/**
 * All proxies assigned to Telegram channels of this manager — the candidates
 * the health sweep probes. Includes the channel each proxy currently serves.
 */
export async function listTelegramProxyAssignments(): Promise<
  Array<{ channelId: string; proxyId: string; managerId: string }>
> {
  const rows = await query<{
    channel_id: string
    proxy_id: string
    manager_id: string
  }>(
    `SELECT c.id AS channel_id, p.id AS proxy_id, p.manager_id
       FROM channels c
       JOIN proxies p ON p.id = c.proxy_id
      WHERE c.type = 'telegram' AND c.proxy_id IS NOT NULL`,
  )
  return rows.map((r) => ({
    channelId: r.channel_id,
    proxyId: r.proxy_id,
    managerId: r.manager_id,
  }))
}

/**
 * Healthy, UNASSIGNED-for-telegram proxies of one manager, fastest first —
 * the candidate pool for automatic failover. Respects the allocation rule
 * from scripts/040 (one proxy serves at most one account per channel type):
 * a proxy already backing another Telegram channel is excluded.
 */
export async function listFailoverProxyCandidates(
  managerId: string,
): Promise<ProxyPickRow[]> {
  const rows = await query<
    ProxyRow & { id: string; manager_id: string; latency_ms: number | null }
  >(
    `SELECT ${proxyCols('p')}, p.manager_id, p.latency_ms
       FROM proxies p
      WHERE p.manager_id = $1
        AND p.status = 'ok'
        AND p.kind IN ('socks5', 'mtproto')
        AND NOT EXISTS (
          SELECT 1 FROM channels c
           WHERE c.proxy_id = p.id AND c.type = 'telegram'
        )
      ORDER BY p.latency_ms ASC NULLS LAST, p.created_at ASC`,
    [managerId],
  )
  return rows.map((r) => ({
    id: r.id,
    manager_id: r.manager_id,
    latency_ms: r.latency_ms,
    config: rowToProxyConfig(r),
  }))
}

/**
 * Atomically repoint a channel at a new proxy. The WHERE guard keeps the
 * migration honest if an admin reassigned the proxy mid-sweep.
 */
export async function reassignChannelProxy(
  channelId: string,
  fromProxyId: string,
  toProxyId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE channels SET proxy_id = $3
      WHERE id = $1 AND proxy_id = $2
      RETURNING id`,
    [channelId, fromProxyId, toProxyId],
  )
  return rows.length > 0
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


/* --------------------------------------------------------------------------
 * Domain re-exports. Message-media and AI/autopilot concerns were split into
 * focused sibling modules; consumers keep importing them via `repo.*`.
 * ------------------------------------------------------------------------ */
export * from './repo-media.js'
export * from './repo-messages.js'
export * from './repo-ai.js'
