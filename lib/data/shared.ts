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
  Channel,
  ChannelStatus,
  ChannelType,
  Conversation,
  ConversationMeta,
  LeadStatus,
  Manager,
  ManagerStatus,
  MediaType,
  Message,
  MessageReaction,
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
        rt.id AS reply_to_id, rt.author AS reply_to_author,
        rt.body AS reply_to_body, rt.media_type AS reply_to_media_type`
export const MESSAGE_REPLY_JOIN = `LEFT JOIN messages rt ON rt.id = m.reply_to_message_id`

/* ----------------------------- Converters ----------------------------- */

export function toManager(r: ManagerRow): Manager {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    username: r.username ?? null,
    status: r.status,
    onLunch: r.on_lunch ?? false,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

export function sanitizeChannelConfig(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!config) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (!SECRET_CONFIG_KEYS.has(k)) out[k] = v
  }
  return out
}

export function toChannel(r: ChannelRow): Channel {
  return {
    id: r.id,
    managerId: r.manager_id,
    type: r.type,
    name: r.name,
    detail: r.detail,
    status: r.status,
    sessionStatus: r.session_status ?? 'idle',
    ingestPaused: r.ingest_paused ?? false,
    phone: r.phone ?? null,
    proxyId: r.proxy_id ?? null,
    lastError: r.last_error ?? null,
    config: sanitizeChannelConfig(r.config),
    createdAt: new Date(r.created_at).toISOString(),
    connectedAt: r.connected_at
      ? new Date(r.connected_at).toISOString()
      : null,
    lastCheckedAt: r.last_checked_at
      ? new Date(r.last_checked_at).toISOString()
      : null,
  }
}

export function toConversation(r: ConversationRow): Conversation {
  const manual = (r.status ?? null) as LeadStatus | null
  const detail = (r.status_detail ?? null) as NotLiquidReason | null
  return {
    id: r.id,
    channelId: r.channel_id,
    managerId: r.manager_id,
    channelType: r.channel_type,
    // Reversible "names glitch": show "NULL" while hidden, real name is intact in DB.
    contactName: r.contact_name_hidden ? 'NULL' : r.contact_name,
    contactHandle: r.contact_handle,
    contactUsername: r.contact_username ?? undefined,
    lastMessage: r.last_message,
    lastMessageAt: new Date(r.last_message_at).toISOString(),
    unread: Number(r.unread),
    status: manual ?? DEFAULT_LEAD_STATUS,
    statusDetail:
      manual === 'not_liquid' && detail ? detail : undefined,
    statusManual: manual !== null,
    statusUpdatedAt: r.status_updated_at
      ? new Date(r.status_updated_at).toISOString()
      : undefined,
    replyDismissedAt: r.reply_dismissed_at
      ? new Date(r.reply_dismissed_at).toISOString()
      : undefined,
    muted: Boolean(r.muted),
    contactBlocked: Boolean(r.contact_blocked),
    visitorNo:
      r.visitor_no === null || r.visitor_no === undefined
        ? undefined
        : Number(r.visitor_no),
    meta:
      r.meta && Object.keys(r.meta).length > 0
        ? (r.meta as ConversationMeta)
        : undefined,
    aiAutopilotEnabled: Boolean(r.ai_autopilot_enabled),
    aiPaused: Boolean(r.ai_paused),
    aiHandoffPending: Boolean(r.ai_handoff_pending),
    aiHandoffAt: r.ai_handoff_at
      ? new Date(r.ai_handoff_at).toISOString()
      : undefined,
  }
}

/**
 * Map a raw `messages` row (with optional media columns) to a `Message`.
 * `mediaUrl` points at the panel proxy that streams the bytes on demand.
 */
export function toMessage(r: {
  id: string
  conversation_id: string
  direction: 'in' | 'out'
  body: string
  author: string
  created_at: string | Date
  media_type?: MediaType | null
  media_mime?: string | null
  media_name?: string | null
  reactions?: unknown
  deleted_at?: string | Date | null
  deleted_origin?: 'self' | 'remote' | null
  status?: MessageStatus | null
  error_reason?: string | null
  reply_to_id?: string | null
  reply_to_author?: string | null
  reply_to_body?: string | null
  reply_to_media_type?: MediaType | null
}): Message {
  const reactions = Array.isArray(r.reactions)
    ? (r.reactions as MessageReaction[]).filter(
        (x) => x && typeof x.emoji === 'string',
      )
    : []
  return {
    id: r.id,
    conversationId: r.conversation_id,
    direction: r.direction,
    body: r.body,
    author: r.author,
    createdAt: new Date(r.created_at).toISOString(),
    ...(r.media_type
      ? {
          mediaType: r.media_type,
          mediaMime: r.media_mime ?? undefined,
          mediaName: r.media_name ?? undefined,
          mediaUrl: `/api/media/${r.id}`,
        }
      : {}),
    ...(reactions.length ? { reactions } : {}),
    ...(r.deleted_at ? { deletedAt: new Date(r.deleted_at).toISOString() } : {}),
    ...(r.deleted_origin ? { deletedOrigin: r.deleted_origin } : {}),
    ...(r.status ? { status: r.status } : {}),
    ...(r.error_reason ? { errorReason: r.error_reason } : {}),
    ...(r.reply_to_id
      ? {
          replyTo: {
            id: r.reply_to_id,
            author: r.reply_to_author ?? '',
            body: r.reply_to_body ?? '',
            ...(r.reply_to_media_type
              ? { mediaType: r.reply_to_media_type }
              : {}),
          },
        }
      : {}),
  }
}

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
  const valid = await query<{ id: string }>(
    'SELECT id FROM managers WHERE id = $1 LIMIT 1',
    [candidate],
  )
  if (valid[0]) return candidate

  const alive = await query<{ id: string }>(
    'SELECT id FROM managers WHERE id = ANY($1::uuid[]) LIMIT 1',
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
