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
  type: 'telegram' | 'telegram_personal' | 'whatsapp' | 'livechat' | 'max'
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
             type IN ('telegram', 'telegram_personal')
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
         (type IN ('telegram', 'telegram_personal') AND EXISTS (
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
