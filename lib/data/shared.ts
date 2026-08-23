/**
 * Shared data-layer primitives used across more than one domain module.
 *
 * This module centralises the row shapes, row→domain converters, reusable SQL
 * fragments and generic helpers that the split `lib/data/*` domain modules all
 * depend on. Keeping them here (instead of importing between domain modules)
 * avoids circular dependencies: every domain imports FROM shared, shared
 * imports from nothing in `lib/data`.
 */
import { query } from '../db'
import type {
  AccountRole,
  ChannelStatus,
  ChannelType,
  ConversationMeta,
  LeadStatus,
  ManagerStatus,
  MediaType,
  MessageStatus,
  NotLiquidReason,
  SessionStatus,
} from '../types'

/* ----------------------------- Row shapes ----------------------------- */

export interface ManagerRow {
  id: string
  name: string
  email: string
  username: string | null
  password_hash: string
  status: ManagerStatus
  session_version: number
  on_lunch: boolean | null
  /** Account role on the managers table (migration 111). */
  role: AccountRole | null
  /** City the curator is responsible for; null for managers. */
  city: string | null
  /** Edit permission for role = 'head' (migration 141). */
  head_can_edit: boolean | null
  /** Telegram-контакт куратора для кандидатов (миграция 146). */
  telegram_contact: string | null
  created_at: string | Date
}

export interface ChannelRow {
  id: string
  manager_id: string | null
  type: ChannelType
  name: string
  detail: string
  status: ChannelStatus
  session_status: SessionStatus
  ingest_paused: boolean | null
  phone: string | null
  proxy_id: string | null
  last_error: string | null
  config: Record<string, unknown>
  created_at: string | Date
  connected_at: string | Date | null
  last_checked_at: string | Date | null
  session_status_changed_at: string | Date | null
}

export interface ConversationRow {
  id: string
  channel_id: string
  manager_id: string
  channel_type: ChannelType
  contact_name: string
  contact_handle: string
  contact_username?: string | null
  last_message: string
  last_message_at: string | Date
  unread: number
  status?: LeadStatus | null
  status_detail?: NotLiquidReason | null
  status_updated_at?: string | Date | null
  reply_dismissed_at?: string | Date | null
  muted?: boolean | null
  meta?: ConversationMeta | null
  visitor_no?: number | null
  contact_blocked?: boolean | null
  contact_name_hidden?: boolean | null
  ai_autopilot_enabled?: boolean | null
  ai_paused?: boolean | null
  ai_handoff_pending?: boolean | null
  ai_handoff_at?: string | Date | null
  created_at?: string | Date | null
}

export interface MessageRow {
  id: string
  conversation_id: string
  direction: 'in' | 'out'
  body: string
  author: string
  created_at: string | Date
  media_type: MediaType | null
  media_mime: string | null
  media_name: string | null
  reactions: unknown
  deleted_at: string | Date | null
  deleted_origin: 'self' | 'remote' | null
  status: MessageStatus | null
  error_reason: string | null
  reply_to_id: string | null
  reply_to_author: string | null
  reply_to_body: string | null
  reply_to_media_type: MediaType | null
}

/* ----------------------------- Constants ----------------------------- */

// Secret keys stored inside channel.config that must NEVER reach the client
// (e.g. the encrypted WhatsApp Cloud token / app secret / verify token). The
// non-secret `provider` marker is kept so the UI can tell Cloud from legacy.
export const SECRET_CONFIG_KEYS = new Set([
  'token',
  'appSecret',
  'verifyToken',
  'session',
  'creds',
])

/**
 * Default lead status when a manager hasn't pinned one. Every contact that
 * wrote in starts as «Отписок». Keep this in sync with effectiveStatusSql()
 * so JS and DB derivations never diverge.
 */
export const DEFAULT_LEAD_STATUS: LeadStatus = 'unsubscribed'

/**
 * The administrator is authenticated purely from environment variables and has
 * NO row in the `managers` table (see lib/auth.ts). If a manager row was ever
 * created with the admin's email/login (e.g. a legacy seed), it must never be
 * treated as a real manager: an admin is not part of the conversation-handling
 * pool, must not be assignable/transferable, and must not be blockable through
 * the manager UI (blocking the admin identity would be meaningless and
 * confusing). These helpers let manager-facing queries defensively exclude it.
 */
function adminIdentifiers(): string[] {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  const username = (
    process.env.ADMIN_USERNAME ||
    email.split('@')[0] ||
    ''
  )
    .trim()
    .toLowerCase()
  return [email, username].filter(Boolean)
}

/** True when a manager row actually represents the env-backed administrator. */
export function isAdminIdentity(
  m: { email?: string | null; username?: string | null } | null | undefined,
): boolean {
  if (!m) return false
  const ids = adminIdentifiers()
  if (ids.length === 0) return false
  const email = (m.email || '').trim().toLowerCase()
  const username = (m.username || '').trim().toLowerCase()
  return (email !== '' && ids.includes(email)) ||
    (username !== '' && ids.includes(username))
}

/**
 * A reusable SQL predicate (for a `managers` alias) that excludes the admin
 * identity from a result set. Returns an empty string when no admin email is
 * configured. Uses inlined, lowercased literals derived from env (never user
 * input), so it's safe to interpolate and needs no bound parameters.
 */
export function excludeAdminSql(alias = 'managers'): string {
  const ids = adminIdentifiers()
  if (ids.length === 0) return ''
  const list = ids.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')
  return `AND lower(${alias}.email) NOT IN (${list}) AND lower(COALESCE(${alias}.username, '')) NOT IN (${list})`
}

/**
 * SQL expression deriving the effective lead status of a conversation, matching
 * DEFAULT_LEAD_STATUS on the JS side. Shared between conversation queries and
 * analytics rollups so both agree on how a null status is interpreted.
 *
 * Pass the `conversations` table alias whenever the query JOINs another table
 * that also has a `status` column (e.g. `channels`, `managers`). Without the
 * qualifier Postgres raises `column reference "status" is ambiguous`.
 */
export function effectiveStatusSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : ''
  return `COALESCE(${prefix}status, 'unsubscribed')`
}

/**
 * Shared SELECT column list + self-join for hydrating a message with its
 * reactions, soft-delete marker and quoted-reply preview. `m` is the messages
 * alias; `rt` is the joined reply-target alias.
 */
export const MESSAGE_SELECT = `m.id, m.conversation_id, m.direction, m.body, m.author, m.created_at,
        m.media_type, m.media_mime, m.media_name, m.reactions, m.deleted_at, m.deleted_origin, m.status, m.error_reason,
        m.edited_at, m.edit_count,
        rt.id AS reply_to_id, rt.author AS reply_to_author,
        rt.body AS reply_to_body, rt.media_type AS reply_to_media_type`
export const MESSAGE_REPLY_JOIN = `LEFT JOIN messages rt ON rt.id = m.reply_to_message_id`

/**
 * Explicit column lists for the core entities, replacing `SELECT *`.
 *
 * Selecting named columns (instead of `*`) means adding a column to a table
 * never silently widens every query that reads it, and it keeps the wire payload
 * limited to exactly what the row mapper consumes. Each list is the authoritative
 * mirror of the matching *Row interface above — keep them in sync when a column
 * is added to (or removed from) a row type.
 *
 * Each helper takes the table alias used in the query (default = table name) so
 * the same list works for both `SELECT ... FROM managers` and joined
 * `SELECT m... FROM ... m` shapes.
 */
const MANAGER_COLUMN_NAMES = [
  'id', 'name', 'email', 'username', 'password_hash', 'status',
  'session_version', 'on_lunch', 'role', 'city', 'head_can_edit',
  'telegram_contact', 'created_at',
] as const

const CHANNEL_COLUMN_NAMES = [
  'id', 'manager_id', 'type', 'name', 'detail', 'status', 'session_status',
  'ingest_paused', 'phone', 'proxy_id', 'last_error', 'config', 'created_at',
  'connected_at', 'last_checked_at', 'session_status_changed_at',
] as const

const CONVERSATION_COLUMN_NAMES = [
  'id', 'channel_id', 'manager_id', 'channel_type', 'contact_name',
  'contact_handle', 'contact_username', 'last_message', 'last_message_at',
  'unread', 'status', 'status_detail', 'status_updated_at', 'reply_dismissed_at',
  'muted', 'meta', 'visitor_no', 'contact_blocked', 'contact_name_hidden',
  'ai_autopilot_enabled', 'ai_paused', 'ai_handoff_pending', 'ai_handoff_at',
  'created_at',
] as const

function qualify(cols: readonly string[], alias: string): string {
  return cols.map((c) => `${alias}.${c}`).join(', ')
}

/** Column list for `managers` (mirrors ManagerRow). */
export function managerColumns(alias = 'managers'): string {
  return qualify(MANAGER_COLUMN_NAMES, alias)
}

/** Column list for `channels` (mirrors ChannelRow). */
export function channelColumns(alias = 'channels'): string {
  return qualify(CHANNEL_COLUMN_NAMES, alias)
}

/** Column list for `conversations` (mirrors ConversationRow). */
export function conversationColumns(alias = 'conversations'): string {
  return qualify(CONVERSATION_COLUMN_NAMES, alias)
}

/* ----------------------------- Converters ----------------------------- */

/*
 * Row → domain converters moved to shared-converters.ts; re-exported here so
 * every existing `./shared` import keeps working. The import cycle is benign:
 * shared-converters only reads DEFAULT_LEAD_STATUS / SECRET_CONFIG_KEYS inside
 * function bodies (call time), never at module evaluation.
 */
export {
  sanitizeChannelConfig,
  toChannel,
  toConversation,
  toManager,
  toMessage,
} from './shared-converters'

/* ----------------------------- Helpers ----------------------------- */

export function readPool(
  config: { pool?: unknown },
  fallbackManagerId: string | null,
): string[] {
  const raw = Array.isArray(config.pool) ? config.pool : []
  const cleaned = raw
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length > 0)
  const unique = Array.from(new Set(cleaned))
  // An empty pool means "owner only" — keep the previous single-manager flow.
  if (unique.length > 0) return unique
  return fallbackManagerId ? [fallbackManagerId] : []
}

export async function assignManagerRoundRobin(
  channelId: string,
  pool: string[],
  fallbackManagerId: string,
): Promise<string> {
  if (pool.length <= 1) return pool[0] ?? fallbackManagerId

  const rows = await query<{ cursor: number }>(
    `UPDATE channels
        SET config = jsonb_set(
              COALESCE(config, '{}'::jsonb),
              '{rrCursor}',
              to_jsonb(COALESCE((config->>'rrCursor')::int, 0) + 1)
            )
      WHERE id = $1
      RETURNING (config->>'rrCursor')::int AS cursor`,
    [channelId],
  )
  const cursor = rows[0]?.cursor ?? 1
  const candidate = pool[(cursor - 1) % pool.length]

  // Guard against a stale id (e.g. a manager removed from the system but still
  // listed in the pool) so we never violate the conversations FK.
  // Only real managers (role = 'manager') may receive conversations.
  const valid = await query<{ id: string }>(
    `SELECT id FROM managers WHERE id = $1 AND role = 'manager' LIMIT 1`,
    [candidate],
  )
  if (valid[0]) return candidate

  const alive = await query<{ id: string }>(
    `SELECT id FROM managers WHERE id = ANY($1::uuid[]) AND role = 'manager' LIMIT 1`,
    [pool],
  )
  return alive[0]?.id ?? fallbackManagerId
}

/**
 * Keep only present, string visitor-meta fields and cap their length, so we
 * never store empty placeholders or oversized blobs. Defensive against whatever
 * the public widget endpoint receives.
 */
export function sanitizeConversationMeta(
  meta: ConversationMeta | undefined,
): ConversationMeta {
  if (!meta || typeof meta !== 'object') return {}
  const out: ConversationMeta = {}
  const keys: (keyof ConversationMeta)[] = [
    'ip',
    'userAgent',
    'language',
    'timezone',
    'screen',
    'page',
    'referrer',
    'subject',
  ]
  for (const k of keys) {
    const v = meta[k]
    if (typeof v === 'string') {
      const trimmed = v.trim().slice(0, 512)
      if (trimmed) out[k] = trimmed
    }
  }
  return out
}

/**
 * Batch-fetch a per-conversation slice of messages for MANY conversations in
 * ONE query (row_number window over `PARTITION BY conversation_id`). This is
 * the shared cure for the N+1 pattern of looping over conversation ids and
 * running a per-id transcript query — with 20-50 dialogs that was 20-50
 * sequential round-trips to Postgres.
 *
 * `order: 'asc'` returns the FIRST `perConversation` messages (transcripts /
 * training corpora), `'desc'` the LAST ones — but always sorted ascending
 * within each conversation so callers can render chronologically either way.
 */
export async function fetchMessageSlicesBatch(
  conversationIds: string[],
  opts: { perConversation: number; order: 'asc' | 'desc' },
): Promise<Map<string, Array<{ direction: 'in' | 'out'; body: string }>>> {
  const out = new Map<
    string,
    Array<{ direction: 'in' | 'out'; body: string }>
  >()
  if (conversationIds.length === 0) return out
  const cap = Math.max(1, Math.min(200, Math.round(opts.perConversation)))
  const dir = opts.order === 'desc' ? 'DESC' : 'ASC'
  const rows = await query<{
    conversation_id: string
    direction: 'in' | 'out'
    body: string
  }>(
    `SELECT conversation_id, direction, body FROM (
       SELECT m.conversation_id, m.direction, m.body, m.created_at,
              row_number() OVER (
                PARTITION BY m.conversation_id
                ORDER BY m.created_at ${dir}
              ) AS rn
         FROM messages m
        WHERE m.conversation_id = ANY($1)
          AND m.deleted_at IS NULL AND m.body <> ''
     ) t
     WHERE rn <= $2
     ORDER BY conversation_id, created_at ASC`,
    [conversationIds, cap],
  )
  for (const r of rows) {
    const list = out.get(r.conversation_id)
    if (list) list.push({ direction: r.direction, body: r.body })
    else out.set(r.conversation_id, [{ direction: r.direction, body: r.body }])
  }
  return out
}

/**
 * Atomically take the next index from a named round-robin counter. The counter
 * grows forever; callers apply `% length` so distribution wraps around the
 * configured list ("when links run out, continue from the start").
 */
export async function nextRoundRobinIndex(name: string): Promise<number> {
  const rows = await query<{ n: string | number }>(
    `INSERT INTO offhours_counters (name, n)
       VALUES ($1, 1)
     ON CONFLICT (name)
       DO UPDATE SET n = offhours_counters.n + 1
     RETURNING n`,
    [name],
  )
  // The just-incremented value is the 1-based count; convert to a 0-based index.
  const n = Number(rows[0]?.n ?? 1)
  return (n - 1) % Number.MAX_SAFE_INTEGER
}
