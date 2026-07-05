import { randomUUID, randomBytes } from 'crypto'
import { query } from './db'
import { decrypt, encrypt, maskSecret } from './crypto'
import type { ProxyDescriptor } from './proxy-agent'
import { whatsappLinkFromPhone } from './offhours'
import {
  resolveGlobalDefaults,
  resolveWidgetConfig,
  type LivechatGlobalDefaults,
  type LivechatWidgetConfig,
  type WidgetWorkingHours,
} from './widget-config'
import type {
  Channel,
  ChannelJob,
  ChannelStatus,
  ChannelType,
  Conversation,
  ConversationMeta,
  JobAction,
  JobStatus,
  LeadStatus,
  Manager,
  ManagerStatus,
  MediaType,
  Message,
  MessageReaction,
  MessageStatus,
  ManagerProxySummary,
  NotLiquidReason,
  Proxy,
  ProxyAnalytics,
  ProxyKind,
  ProxyStatus,
  QuickReply,
  Role,
  SessionStatus,
} from './types'

/**
 * Unified data-access layer over PostgreSQL. Components and server actions only
 * import from here so the SQL stays in one place.
 */

interface ManagerRow {
  id: string
  name: string
  email: string
  password_hash: string
  status: ManagerStatus
  session_version: number
  on_lunch: boolean | null
  created_at: string | Date
}

interface ChannelRow {
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

function toManager(r: ManagerRow): Manager {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    status: r.status,
    onLunch: r.on_lunch ?? false,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

// Secret keys stored inside channel.config that must NEVER reach the client
// (e.g. the encrypted WhatsApp Cloud token / app secret / verify token). The
// non-secret `provider` marker is kept so the UI can tell Cloud from legacy.
const SECRET_CONFIG_KEYS = new Set([
  'token',
  'appSecret',
  'verifyToken',
  'session',
  'creds',
])

function sanitizeChannelConfig(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!config) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (!SECRET_CONFIG_KEYS.has(k)) out[k] = v
  }
  return out
}

function toChannel(r: ChannelRow): Channel {
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

/* ----------------------------- Managers ----------------------------- */

export interface ManagerWithSecret extends Manager {
  passwordHash: string
  sessionVersion: number
}

export async function getManagerByEmail(
  email: string,
): Promise<ManagerWithSecret | null> {
  const normalized = email.trim().toLowerCase()
  const rows = await query<ManagerRow>(
    'SELECT * FROM managers WHERE lower(email) = $1 LIMIT 1',
    [normalized],
  )
  if (!rows[0]) return null
  return {
    ...toManager(rows[0]),
    passwordHash: rows[0].password_hash,
    sessionVersion: rows[0].session_version ?? 0,
  }
}

/**
 * Lightweight auth-state lookup used on every authenticated request to validate
 * a manager's session against the live DB (blocked status + session version).
 * Returns null when the manager no longer exists.
 */
export async function getManagerAuthState(
  id: string,
): Promise<{ status: ManagerStatus; sessionVersion: number } | null> {
  const rows = await query<{
    status: ManagerStatus
    session_version: number
  }>('SELECT status, session_version FROM managers WHERE id = $1 LIMIT 1', [id])
  if (!rows[0]) return null
  return {
    status: rows[0].status,
    sessionVersion: rows[0].session_version ?? 0,
  }
}

export async function getManagerById(id: string): Promise<Manager | null> {
  const rows = await query<ManagerRow>(
    'SELECT * FROM managers WHERE id = $1 LIMIT 1',
    [id],
  )
  return rows[0] ? toManager(rows[0]) : null
}

export async function listManagers(): Promise<Manager[]> {
  const rows = await query<ManagerRow>(
    'SELECT * FROM managers ORDER BY created_at DESC',
  )
  return rows.map(toManager)
}

export async function createManager(input: {
  name: string
  email: string
  passwordHash: string
}): Promise<Manager> {
  const id = randomUUID()
  const email = input.email.trim().toLowerCase()
  const rows = await query<ManagerRow>(
    `INSERT INTO managers (id, name, email, password_hash, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
    [id, input.name.trim(), email, input.passwordHash],
  )
  return toManager(rows[0])
}

export async function updateManagerStatus(
  id: string,
  status: ManagerStatus,
): Promise<void> {
  // Blocking a manager must also revoke their live sessions immediately, so
  // bump session_version when (and only when) they are being blocked.
  await query(
    `UPDATE managers
        SET status = $2,
            session_version = session_version + CASE WHEN $2 = 'blocked' THEN 1 ELSE 0 END
      WHERE id = $1`,
    [id, status],
  )
}

export async function updateManagerPassword(
  id: string,
  passwordHash: string,
): Promise<void> {
  // Any password change invalidates all outstanding sessions for this manager
  // by advancing session_version. The session that initiated a self-service
  // change must re-issue its cookie afterwards (see changeOwnPasswordAction).
  await query(
    'UPDATE managers SET password_hash = $2, session_version = session_version + 1 WHERE id = $1',
    [id, passwordHash],
  )
}

export async function deleteManager(id: string): Promise<void> {
  // Telegram/WhatsApp channels are bound to this manager's worker session, so
  // they should still go away with the manager. After migration 008 the FK is
  // ON DELETE SET NULL (to protect live-chat), so we remove them explicitly to
  // preserve the previous behaviour for these worker-backed channels.
  await query(
    `DELETE FROM channels WHERE manager_id = $1 AND type <> 'livechat'`,
    [id],
  )
  // Live-chat channels are standalone resources and must SURVIVE manager
  // deletion. Strip this manager's id out of every live-chat round-robin pool
  // so routing never points at a ghost manager. The channels.manager_id FK
  // (ON DELETE SET NULL) keeps the channel itself; it simply shows "no agents
  // available" in the widget until a manager is assigned again.
  await query(
    `UPDATE channels
        SET config = jsonb_set(
              COALESCE(config, '{}'::jsonb),
              '{pool}',
              COALESCE(
                (
                  SELECT jsonb_agg(p)
                  FROM jsonb_array_elements_text(config->'pool') AS p
                  WHERE p <> $1
                ),
                '[]'::jsonb
              )
            )
      WHERE type = 'livechat'
        AND config->'pool' IS NOT NULL`,
    [id],
  )
  // Finally remove the manager. Their own conversations cascade away; live-chat
  // channels they owned have manager_id set to NULL by the FK.
  await query('DELETE FROM managers WHERE id = $1', [id])
}

/* ----------------------------- Channels ----------------------------- */

export async function listChannels(managerId: string): Promise<Channel[]> {
  const rows = await query<ChannelRow>(
    'SELECT * FROM channels WHERE manager_id = $1 ORDER BY created_at DESC',
    [managerId],
  )
  return rows.map(toChannel)
}

export async function listAllChannels(): Promise<Channel[]> {
  const rows = await query<ChannelRow>(
    'SELECT * FROM channels ORDER BY created_at DESC',
  )
  return rows.map(toChannel)
}

export async function createChannel(input: {
  managerId: string
  type: ChannelType
  name: string
  detail: string
  status: ChannelStatus
  sessionStatus?: SessionStatus
  phone?: string | null
  proxyId?: string | null
  config: Record<string, unknown>
}): Promise<Channel> {
  const id = randomUUID()
  const lastChecked = input.status === 'connected' ? new Date() : null
  const sessionStatus = input.sessionStatus ?? 'idle'
  const rows = await query<ChannelRow>(
    `INSERT INTO channels
       (id, manager_id, type, name, detail, status, session_status, phone, proxy_id, config, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      id,
      input.managerId,
      input.type,
      input.name,
      input.detail,
      input.status,
      sessionStatus,
      input.phone ?? null,
      input.proxyId ?? null,
      JSON.stringify(input.config),
      lastChecked,
    ],
  )
  return toChannel(rows[0])
}

export async function updateChannelStatus(
  id: string,
  managerId: string,
  status: ChannelStatus,
): Promise<void> {
  await query(
    'UPDATE channels SET status = $3, last_checked_at = now() WHERE id = $1 AND manager_id = $2',
    [id, managerId, status],
  )
}

export async function deleteChannel(
  id: string,
  managerId: string,
): Promise<void> {
  await query('DELETE FROM channels WHERE id = $1 AND manager_id = $2', [
    id,
    managerId,
  ])
}

export async function getChannel(
  id: string,
  managerId: string,
): Promise<Channel | null> {
  const rows = await query<ChannelRow>(
    'SELECT * FROM channels WHERE id = $1 AND manager_id = $2 LIMIT 1',
    [id, managerId],
  )
  return rows[0] ? toChannel(rows[0]) : null
}

/** Admin: delete any channel by id (no manager scope). */
export async function deleteChannelById(id: string): Promise<void> {
  await query('DELETE FROM channels WHERE id = $1', [id])
}

export interface LivechatWidgetAppearance {
  /** Header title shown in the widget panel. */
  title: string
  /** Primary brand color (hex). Empty string = widget default. */
  color: string
  /** Optional greeting teaser bubble text. Empty = no teaser. */
  greeting: string
}

export interface LivechatAdminChannel extends Channel {
  managerName: string | null
  domain: string
  apiKey: string
  /** Ordered manager ids that share this site's conversations (round-robin). */
  pool: string[]
  /** Display names for the pool, aligned to `pool` order. */
  poolNames: string[]
  /** Widget look & feel, edited from the admin and baked into the snippet. */
  appearance: LivechatWidgetAppearance
  /** Full per-site widget configuration (resolved with global defaults). */
  widget: LivechatWidgetConfig
}

/** Admin: list every live-chat channel with assigned manager + widget config. */
export async function listLivechatChannels(): Promise<LivechatAdminChannel[]> {
  const [rows, managers, globals] = await Promise.all([
    query<ChannelRow & { manager_name: string | null }>(
      `SELECT c.*, m.name AS manager_name
         FROM channels c
         LEFT JOIN managers m ON m.id = c.manager_id
        WHERE c.type = 'livechat'
        ORDER BY c.created_at DESC`,
    ),
    listManagers(),
    getLivechatGlobalDefaults(),
  ])
  const nameById = new Map(managers.map((m) => [m.id, m.name]))
  return rows.map((r) => {
    const base = toChannel(r)
    const config = (r.config ?? {}) as {
      domain?: string
      apiKey?: string
      pool?: unknown
      appearance?: Partial<LivechatWidgetAppearance>
      widget?: unknown
    }
    const pool = readPool(config, r.manager_id).filter((id) => nameById.has(id))
    const appearance = config.appearance ?? {}
    // Resolve the full widget config, seeding legacy top-level `appearance`
    // (title/color/greeting) so pre-editor sites keep their look.
    const widget = resolveWidgetConfig(
      mergeLegacyAppearance(config.widget, appearance),
      globals,
    )
    return {
      ...base,
      managerName: r.manager_name ?? null,
      domain: String(config.domain ?? ''),
      apiKey: String(config.apiKey ?? ''),
      pool,
      poolNames: pool.map((id) => nameById.get(id) ?? 'Unknown'),
      appearance: {
        title: String(appearance.title ?? ''),
        color: String(appearance.color ?? ''),
        greeting: String(appearance.greeting ?? ''),
      },
      widget,
    }
  })
}

/**
 * Back-compat: fold the legacy `config.appearance` (title/color/greeting) into
 * the new widget blob when the site has not been edited with the new editor.
 * Explicit widget values always win over the legacy ones.
 */
function mergeLegacyAppearance(
  widget: unknown,
  legacy: Partial<LivechatWidgetAppearance>,
): unknown {
  const w = (widget ?? {}) as Record<string, unknown>
  const wAppearance = (w.appearance ?? {}) as Record<string, unknown>
  const merged: Record<string, unknown> = {
    ...wAppearance,
  }
  if (merged.title == null && legacy.title) merged.title = legacy.title
  if (merged.color == null && legacy.color) merged.color = legacy.color
  if (merged.greeting == null && legacy.greeting)
    merged.greeting = legacy.greeting
  return { ...w, appearance: merged }
}

/* ----------------------- Global widget defaults --------------------- */

const LIVECHAT_DEFAULTS_KEY = 'livechat_defaults'

/** Read the admin-wide widget defaults (currently the default working hours). */
export async function getLivechatGlobalDefaults(): Promise<LivechatGlobalDefaults> {
  const rows = await query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [LIVECHAT_DEFAULTS_KEY],
  )
  return resolveGlobalDefaults(rows[0]?.value)
}

/** Admin: persist the admin-wide widget defaults. */
export async function saveLivechatGlobalDefaults(
  input: LivechatGlobalDefaults,
): Promise<void> {
  const value = resolveGlobalDefaults(input)
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [LIVECHAT_DEFAULTS_KEY, JSON.stringify(value)],
  )
}

/** Admin: persist a site's full widget config under channels.config.widget. */
export async function updateLivechatWidgetConfig(
  channelId: string,
  config: LivechatWidgetConfig,
): Promise<void> {
  await query(
    `UPDATE channels
        SET config = jsonb_set(
              COALESCE(config, '{}'::jsonb),
              '{widget}',
              $2::jsonb
            )
      WHERE id = $1 AND type = 'livechat'`,
    [channelId, JSON.stringify(config)],
  )
}

/**
 * Resolve the full widget config for a single channel id (admin-scoped read).
 * Returns null when the channel does not exist or is not a live-chat channel.
 */
export async function getLivechatWidgetByChannelId(
  channelId: string,
): Promise<LivechatAdminChannel | null> {
  const channels = await listLivechatChannels()
  return channels.find((c) => c.id === channelId) ?? null
}

/**
 * Admin: replace the manager pool for a live-chat channel. The first manager in
 * the list also becomes the channel owner (manager_id) so existing
 * owner-scoped queries keep working. Resets the round-robin cursor so the next
 * visitor starts cleanly at the top of the new pool.
 */
export async function updateLivechatPool(
  channelId: string,
  managerIds: string[],
): Promise<void> {
  const unique = Array.from(
    new Set(managerIds.map((v) => String(v ?? '').trim()).filter(Boolean)),
  )
  if (unique.length === 0) return
  await query(
    `UPDATE channels
        SET manager_id = $2,
            config = jsonb_set(
              jsonb_set(
                COALESCE(config, '{}'::jsonb),
                '{pool}',
                to_jsonb($3::text[])
              ),
              '{rrCursor}',
              '0'::jsonb
            )
      WHERE id = $1 AND type = 'livechat'`,
    [channelId, unique[0], unique],
  )
}

/**
 * Admin: persist widget look & feel (title, color, greeting) into the channel
 * config blob. These are read back by the admin to build the install snippet.
 */
export async function updateLivechatAppearance(
  channelId: string,
  appearance: LivechatWidgetAppearance,
): Promise<void> {
  await query(
    `UPDATE channels
        SET config = jsonb_set(
              COALESCE(config, '{}'::jsonb),
              '{appearance}',
              $2::jsonb
            )
      WHERE id = $1 AND type = 'livechat'`,
    [channelId, JSON.stringify(appearance)],
  )
}

/** Update the live session status / error (used by status polling + worker). */
export async function updateChannelSession(
  id: string,
  managerId: string,
  patch: { sessionStatus?: SessionStatus; lastError?: string | null },
): Promise<void> {
  // Only touch last_error when the caller explicitly provides the key. Passing
  // it through unconditionally would let the panel's status polling wipe an
  // error the worker just set (race), leaving the UI stuck with no message.
  const touchError = Object.prototype.hasOwnProperty.call(patch, 'lastError')
  await query(
    `UPDATE channels
       SET session_status = COALESCE($3, session_status),
           last_error = CASE WHEN $4 THEN $5 ELSE last_error END
     WHERE id = $1 AND manager_id = $2`,
    [id, managerId, patch.sessionStatus ?? null, touchError, patch.lastError ?? null],
  )
}

/**
 * Shallow-merge a patch into a channel's JSONB config (manager-scoped). Existing
 * keys are overwritten by the patch; untouched keys are preserved. Used e.g. to
 * backfill the VK Callback server id once VK assigns it after registration.
 */
export async function mergeChannelConfig(
  id: string,
  managerId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE channels
        SET config = COALESCE(config, '{}'::jsonb) || $3::jsonb
      WHERE id = $1 AND manager_id = $2`,
    [id, managerId, JSON.stringify(patch)],
  )
}

/* ------------------------------ Proxies ----------------------------- */

interface ProxyRow {
  id: string
  manager_id: string | null
  created_by_role: Role
  created_by_manager_id: string | null
  label: string
  kind: ProxyKind
  host: string
  port: number
  username_enc: string | null
  password_enc: string | null
  secret_enc: string | null
  status: ProxyStatus
  last_error: string | null
  created_at: string | Date
  assigned_manager_name?: string | null
  owner_manager_name?: string | null
}

function toProxy(r: ProxyRow): Proxy {
  return {
    id: r.id,
    managerId: r.manager_id ?? null,
    assignedManagerName: r.assigned_manager_name ?? null,
    createdByRole: (r.created_by_role ?? 'admin') as Role,
    createdByManagerId: r.created_by_manager_id ?? null,
    ownerManagerName: r.owner_manager_name ?? null,
    label: r.label,
    kind: r.kind,
    host: r.host,
    port: Number(r.port),
    hasAuth: Boolean(r.username_enc || r.secret_enc),
    status: r.status,
    lastError: r.last_error ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/**
 * Proxies a manager can use: every proxy ASSIGNED to them (admin pool hand-outs
 * + their own self-created proxies, which are auto-assigned to themselves). This
 * is what powers the connect-wizard picker.
 */
export async function listProxies(managerId: string): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT * FROM proxies
      WHERE manager_id = $1 OR created_by_manager_id = $1
      ORDER BY created_at DESC`,
    [managerId],
  )
  return rows.map(toProxy)
}

/**
 * Proxies a manager OWNS (self-created) — the ones they can edit/delete on their
 * own /app/proxies tab. Admin-assigned proxies are intentionally excluded here.
 */
export async function listManagerOwnedProxies(
  managerId: string,
): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT * FROM proxies
      WHERE created_by_role = 'manager' AND created_by_manager_id = $1
      ORDER BY created_at DESC`,
    [managerId],
  )
  return rows.map(toProxy)
}

/**
 * Proxies an admin has ASSIGNED to this manager but that the manager does NOT
 * own (read-only for the manager). Shown for transparency on their tab.
 */
export async function listManagerAssignedProxies(
  managerId: string,
): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT * FROM proxies
      WHERE manager_id = $1::uuid
        AND (created_by_role = 'admin' OR created_by_manager_id <> $1::uuid)
      ORDER BY created_at DESC`,
    [managerId],
  )
  return rows.map(toProxy)
}

/** Every proxy, with assigned-manager and owner-manager names joined in. */
export async function listAllProxies(): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT p.*, m.name AS assigned_manager_name, o.name AS owner_manager_name
       FROM proxies p
       LEFT JOIN managers m ON m.id = p.manager_id
       LEFT JOIN managers o ON o.id = p.created_by_manager_id
      ORDER BY p.created_at DESC`,
  )
  return rows.map(toProxy)
}

export async function getProxyById(id: string): Promise<Proxy | null> {
  const rows = await query<ProxyRow>(
    `SELECT p.*, m.name AS assigned_manager_name, o.name AS owner_manager_name
       FROM proxies p
       LEFT JOIN managers m ON m.id = p.manager_id
       LEFT JOIN managers o ON o.id = p.created_by_manager_id
      WHERE p.id = $1 LIMIT 1`,
    [id],
  )
  return rows[0] ? toProxy(rows[0]) : null
}

/**
 * Create a proxy. Ownership is explicit:
 *   - admin: lands in the pool, optionally pre-assigned to a manager.
 *   - manager: owned by + auto-assigned to that manager (managerId is forced to
 *     the owner so it shows up in their wizard immediately).
 */
export async function createProxy(input: {
  label: string
  kind: ProxyKind
  host: string
  port: number
  username?: string | null
  password?: string | null
  secret?: string | null
  createdByRole: Role
  createdByManagerId?: string | null
  managerId?: string | null
}): Promise<Proxy> {
  const id = randomUUID()
  const usernameEnc = input.username ? encrypt(input.username) : null
  const passwordEnc = input.password ? encrypt(input.password) : null
  const secretEnc = input.secret ? encrypt(input.secret) : null
  const isManager = input.createdByRole === 'manager'
  const ownerId = isManager ? (input.createdByManagerId ?? null) : null
  // Manager-created proxies are always assigned to their creator.
  const assignedTo = isManager ? ownerId : (input.managerId ?? null)
  const rows = await query<ProxyRow>(
    `INSERT INTO proxies
       (id, manager_id, created_by_role, created_by_manager_id, label, kind,
        host, port, username_enc, password_enc, secret_enc, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unknown')
     RETURNING *`,
    [
      id,
      assignedTo,
      input.createdByRole,
      ownerId,
      input.label,
      input.kind,
      input.host,
      input.port,
      usernameEnc,
      passwordEnc,
      secretEnc,
    ],
  )
  return toProxy(rows[0])
}

/** Assign (or unassign with null) a proxy to a manager. Admin only. */
export async function assignProxy(
  id: string,
  managerId: string | null,
): Promise<void> {
  await query('UPDATE proxies SET manager_id = $2 WHERE id = $1', [
    id,
    managerId,
  ])
}

/**
 * Delete a proxy. When ownerManagerId is supplied the delete is SCOPED to a
 * manager's own proxies (a manager can never delete an admin proxy or another
 * manager's proxy). Admin calls omit it for full control. channels.proxy_id is
 * set NULL via the FK either way. Returns true when a row was removed.
 */
export async function deleteProxy(
  id: string,
  ownerManagerId?: string,
): Promise<boolean> {
  if (ownerManagerId) {
    const rows = await query<{ id: string }>(
      `DELETE FROM proxies
        WHERE id = $1 AND created_by_role = 'manager' AND created_by_manager_id = $2
        RETURNING id`,
      [id, ownerManagerId],
    )
    return rows.length > 0
  }
  const rows = await query<{ id: string }>(
    'DELETE FROM proxies WHERE id = $1 RETURNING id',
    [id],
  )
  return rows.length > 0
}

/**
 * Authorisation helper: can this manager run a connectivity check / manage this
 * proxy? True when they own it OR it's assigned to them.
 */
export async function managerCanUseProxy(
  proxyId: string,
  managerId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM proxies
      WHERE id = $1 AND (manager_id = $2 OR created_by_manager_id = $2)
      LIMIT 1`,
    [proxyId, managerId],
  )
  return rows.length > 0
}

/**
 * Resolve a proxy's connection descriptor WITH decrypted credentials, for
 * server-side routing of provider HTTP traffic (see lib/proxy-agent.ts). This
 * returns plaintext proxy credentials — NEVER expose it to the client.
 */
export async function getProxyDescriptorById(
  id: string,
): Promise<ProxyDescriptor | null> {
  const rows = await query<ProxyRow>(
    'SELECT * FROM proxies WHERE id = $1 LIMIT 1',
    [id],
  )
  const r = rows[0]
  if (!r) return null
  let username: string | null = null
  let password: string | null = null
  try {
    if (r.username_enc) username = decrypt(r.username_enc)
    if (r.password_enc) password = decrypt(r.password_enc)
  } catch (err) {
    console.error(
      '[v0] getProxyDescriptorById: failed to decrypt credentials:',
      err,
    )
  }
  return {
    id: r.id,
    kind: r.kind,
    host: r.host,
    port: Number(r.port),
    username,
    password,
  }
}

/**
 * Resolve the proxy descriptor a channel routes through (null when it has none).
 * Used by the VK/MAX/WhatsApp dispatchers so every provider call exits via the
 * account's dedicated proxy IP.
 */
export async function getProxyForChannel(
  channelId: string,
): Promise<ProxyDescriptor | null> {
  const rows = await query<{ proxy_id: string | null }>(
    'SELECT proxy_id FROM channels WHERE id = $1 LIMIT 1',
    [channelId],
  )
  const pid = rows[0]?.proxy_id
  if (!pid) return null
  return getProxyDescriptorById(pid)
}

/**
 * Proxy allocation rule: a proxy serves AT MOST ONE account of each type. True
 * when another channel already uses this proxy for the same type (optionally
 * excluding a channel being edited).
 */
export async function proxyTypeInUse(
  proxyId: string,
  type: ChannelType,
  excludeChannelId?: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM channels
      WHERE proxy_id = $1 AND type = $2
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1`,
    [proxyId, type, excludeChannelId ?? null],
  )
  return rows.length > 0
}

/**
 * Proxies available to assign to a NEW account of `type`: every proxy NOT
 * already bound to another account of the same type (different types may share a
 * proxy). Optionally restricted to a manager's assigned/owned proxies.
 */
export async function listAvailableProxiesForType(
  type: ChannelType,
  managerId?: string,
): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT p.*, m.name AS assigned_manager_name, o.name AS owner_manager_name
       FROM proxies p
       LEFT JOIN managers m ON m.id = p.manager_id
       LEFT JOIN managers o ON o.id = p.created_by_manager_id
      WHERE NOT EXISTS (
              SELECT 1 FROM channels c
               WHERE c.proxy_id = p.id AND c.type = $1
            )
        AND ($2::uuid IS NULL
             OR p.manager_id = $2::uuid
             OR p.created_by_manager_id = $2::uuid)
      ORDER BY p.created_at DESC`,
    [type, managerId ?? null],
  )
  return rows.map(toProxy)
}

/* ----------------------- Admin channel management ------------------- */

export interface AdminChannel extends Channel {
  /** Owner manager display name (null when unassigned/deleted). */
  managerName: string | null
  /** Assigned proxy label, or null when the account has no proxy (legacy). */
  proxyLabel: string | null
}

/**
 * Admin: every messaging account (excludes live-chat, which is managed on its
 * own page) with owner + proxy joined, for the /admin/accounts table.
 */
export async function listAdminChannels(): Promise<AdminChannel[]> {
  const rows = await query<
    ChannelRow & { manager_name: string | null; proxy_label: string | null }
  >(
    `SELECT c.*, m.name AS manager_name, p.label AS proxy_label
       FROM channels c
       LEFT JOIN managers m ON m.id = c.manager_id
       LEFT JOIN proxies p ON p.id = c.proxy_id
      WHERE c.type IN ('telegram', 'whatsapp', 'vk', 'max')
      ORDER BY c.created_at DESC`,
  )
  return rows.map((r) => ({
    ...toChannel(r),
    managerName: r.manager_name ?? null,
    proxyLabel: r.proxy_label ?? null,
  }))
}

/** Admin/webhook: fetch any channel by id (no manager scope). */
export async function getChannelById(id: string): Promise<Channel | null> {
  const rows = await query<ChannelRow>(
    'SELECT * FROM channels WHERE id = $1 LIMIT 1',
    [id],
  )
  return rows[0] ? toChannel(rows[0]) : null
}

/** Admin: reassign the proxy bound to a channel. */
export async function updateChannelProxy(
  id: string,
  proxyId: string | null,
): Promise<void> {
  // proxyId may be null → detach the proxy so the account connects directly.
  await query('UPDATE channels SET proxy_id = $2::uuid WHERE id = $1::uuid', [
    id,
    proxyId,
  ])
}

/** Admin: patch a channel's live session status by id (no manager scope). */
export async function updateChannelSessionById(
  id: string,
  patch: { sessionStatus?: SessionStatus; lastError?: string | null },
): Promise<void> {
  const touchError = Object.prototype.hasOwnProperty.call(patch, 'lastError')
  await query(
    `UPDATE channels
        SET session_status = COALESCE($2, session_status),
            last_error = CASE WHEN $3 THEN $4 ELSE last_error END
      WHERE id = $1`,
    [id, patch.sessionStatus ?? null, touchError, patch.lastError ?? null],
  )
}

/** Admin: shallow-merge a channel's JSONB config by id (no manager scope). */
export async function mergeChannelConfigById(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE channels
        SET config = COALESCE(config, '{}'::jsonb) || $2::jsonb
      WHERE id = $1`,
    [id, JSON.stringify(patch)],
  )
}

/* ------------------------- Proxy analytics ------------------------- */

/** System-wide proxy analytics for the admin proxies page. */
export async function getProxyAnalytics(): Promise<ProxyAnalytics> {
  const [agg, routed] = await Promise.all([
    query<{
      total: string
      ok: string
      error: string
      unknown: string
      assigned: string
      admin_owned: string
      manager_owned: string
    }>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'ok')::int AS ok,
         count(*) FILTER (WHERE status = 'error')::int AS error,
         count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
         count(*) FILTER (WHERE manager_id IS NOT NULL)::int AS assigned,
         count(*) FILTER (WHERE created_by_role = 'admin')::int AS admin_owned,
         count(*) FILTER (WHERE created_by_role = 'manager')::int AS manager_owned
       FROM proxies`,
    ),
    query<{ n: string }>(
      `SELECT count(*)::int AS n FROM channels WHERE proxy_id IS NOT NULL`,
    ),
  ])
  const a = agg[0]
  const total = Number(a?.total ?? 0)
  const assigned = Number(a?.assigned ?? 0)
  return {
    total,
    ok: Number(a?.ok ?? 0),
    error: Number(a?.error ?? 0),
    unknown: Number(a?.unknown ?? 0),
    assigned,
    unassigned: total - assigned,
    adminOwned: Number(a?.admin_owned ?? 0),
    managerOwned: Number(a?.manager_owned ?? 0),
    channelsRouted: Number(routed[0]?.n ?? 0),
  }
}

/**
 * Per-manager proxy rollup for the admin "by manager" view. Every manager is
 * included (even with zero proxies) so the admin sees full coverage. Uses
 * scalar sub-selects keyed by manager id — cheap at this app's scale and keeps
 * the proxy ↔ manager linkage explicit.
 */
export async function listManagersWithProxies(): Promise<ManagerProxySummary[]> {
  const managers = await listManagers()
  if (managers.length === 0) return []
  const rows = await query<{
    manager_id: string
    total: string
    ok: string
    error: string
    unknown: string
    self_owned: string
    admin_assigned: string
  }>(
    `SELECT
       p.manager_id,
       count(*)::int AS total,
       count(*) FILTER (WHERE p.status = 'ok')::int AS ok,
       count(*) FILTER (WHERE p.status = 'error')::int AS error,
       count(*) FILTER (WHERE p.status = 'unknown')::int AS unknown,
       count(*) FILTER (WHERE p.created_by_role = 'manager')::int AS self_owned,
       count(*) FILTER (WHERE p.created_by_role = 'admin')::int AS admin_assigned
     FROM proxies p
     WHERE p.manager_id IS NOT NULL
     GROUP BY p.manager_id`,
  )
  const channelRows = await query<{ manager_id: string; n: string }>(
    `SELECT manager_id, count(*)::int AS n
       FROM channels WHERE proxy_id IS NOT NULL
      GROUP BY manager_id`,
  )
  const byId = new Map(rows.map((r) => [r.manager_id, r]))
  const channelsById = new Map(
    channelRows.map((r) => [r.manager_id, Number(r.n)]),
  )
  return managers.map((manager) => {
    const r = byId.get(manager.id)
    return {
      manager,
      total: Number(r?.total ?? 0),
      ok: Number(r?.ok ?? 0),
      error: Number(r?.error ?? 0),
      unknown: Number(r?.unknown ?? 0),
      selfOwned: Number(r?.self_owned ?? 0),
      adminAssigned: Number(r?.admin_assigned ?? 0),
      channelsRouted: channelsById.get(manager.id) ?? 0,
    }
  })
}

/* ------------------------------- Jobs ------------------------------- */

interface JobRow {
  id: string
  channel_id: string
  manager_id: string
  action: JobAction
  payload: Record<string, unknown>
  status: JobStatus
  result: Record<string, unknown> | null
  last_error: string | null
  created_at: string | Date
  updated_at: string | Date
}

function toJob(r: JobRow): ChannelJob {
  return {
    id: r.id,
    channelId: r.channel_id,
    managerId: r.manager_id,
    action: r.action,
    payload: r.payload ?? {},
    status: r.status,
    result: r.result ?? null,
    lastError: r.last_error ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

/**
 * Enqueue a command for the worker. The INSERT trigger fires pg_notify so the
 * worker picks it up instantly; if the worker is down it drains the queue on
 * next start.
 */
export async function enqueueJob(input: {
  channelId: string
  managerId: string
  action: JobAction
  payload?: Record<string, unknown>
}): Promise<ChannelJob> {
  const id = randomUUID()
  const rows = await query<JobRow>(
    `INSERT INTO channel_jobs (id, channel_id, manager_id, action, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      id,
      input.channelId,
      input.managerId,
      input.action,
      JSON.stringify(input.payload ?? {}),
    ],
  )
  return toJob(rows[0])
}

/* -------------------------- Conversations --------------------------- */

interface ConversationRow {
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
  created_at?: string | Date | null
}

/**
 * Default lead status when a manager hasn't pinned one. Every contact that
 * wrote in starts as «Отписок». Keep this in sync with EFFECTIVE_STATUS_SQL
 * below so JS and DB derivations never diverge.
 */
const DEFAULT_LEAD_STATUS: LeadStatus = 'unsubscribed'

function toConversation(r: ConversationRow): Conversation {
  const manual = (r.status ?? null) as LeadStatus | null
  const detail = (r.status_detail ?? null) as NotLiquidReason | null
  return {
    id: r.id,
    channelId: r.channel_id,
    managerId: r.manager_id,
    channelType: r.channel_type,
    contactName: r.contact_name,
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
    visitorNo:
      r.visitor_no === null || r.visitor_no === undefined
        ? undefined
        : Number(r.visitor_no),
    meta:
      r.meta && Object.keys(r.meta).length > 0
        ? (r.meta as ConversationMeta)
        : undefined,
  }
}

export async function listConversations(
  managerId: string,
): Promise<Conversation[]> {
  const rows = await query<ConversationRow & { channel_name: string | null }>(
    `SELECT c.*, ch.name AS channel_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.manager_id = $1
      ORDER BY c.last_message_at DESC`,
    [managerId],
  )
  return rows.map((r) => ({
    ...toConversation(r),
    channelName: r.channel_name ?? undefined,
  }))
}

/**
 * List a manager's conversations filtered by EFFECTIVE lead status (and, for
 * «Не ликвид», optionally a reason sub-status). Powers the dashboard status
 * board's drill-down modal. Manager-scoped — never leaks other managers' leads.
 */
export async function listConversationsByStatus(
  managerId: string,
  status: LeadStatus,
  reason?: NotLiquidReason,
): Promise<Conversation[]> {
  const params: unknown[] = [managerId, status]
  let reasonFilter = ''
  if (status === 'not_liquid' && reason) {
    params.push(reason)
    reasonFilter = ` AND c.status_detail = $3`
  }
  const rows = await query<ConversationRow & { channel_name: string | null }>(
    `SELECT c.*, ch.name AS channel_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.manager_id = $1
        AND ${EFFECTIVE_STATUS_SQL} = $2${reasonFilter}
      ORDER BY c.last_message_at DESC`,
    params,
  )
  return rows.map((r) => ({
    ...toConversation(r),
    channelName: r.channel_name ?? undefined,
  }))
}

export async function getConversation(
  conversationId: string,
  managerId: string,
): Promise<Conversation | null> {
  const rows = await query<ConversationRow>(
    'SELECT * FROM conversations WHERE id = $1 AND manager_id = $2 LIMIT 1',
    [conversationId, managerId],
  )
  return rows[0] ? toConversation(rows[0]) : null
}

/**
 * Mark a conversation as read on our side: zero its unread counter and return
 * what the worker needs to send read receipts to the contact (so they see our
 * blue ticks). Returns null when the manager doesn't own the conversation.
 */
export async function markConversationRead(
  conversationId: string,
  managerId: string,
): Promise<{
  channelId: string
  channelType: ChannelType
  contactHandle: string
} | null> {
  const rows = await query<{
    channel_id: string
    channel_type: ChannelType
    contact_handle: string
  }>(
    `UPDATE conversations
        SET unread = 0
      WHERE id = $1 AND manager_id = $2
      RETURNING channel_id, channel_type, contact_handle`,
    [conversationId, managerId],
  )
  if (!rows[0]) return null
  return {
    channelId: rows[0].channel_id,
    channelType: rows[0].channel_type,
    contactHandle: rows[0].contact_handle,
  }
}

export async function listMessages(
  conversationId: string,
  managerId: string,
): Promise<Message[]> {
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     ${MESSAGE_REPLY_JOIN}
     WHERE m.conversation_id = $1 AND c.manager_id = $2
     ORDER BY m.created_at ASC`,
    [conversationId, managerId],
  )
  return rows.map(toMessage)
}

/** Raw `messages` row shape (with reply/reaction/delete hydration columns). */
interface MessageRow {
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

/**
 * Map a raw `messages` row (with optional media columns) to a `Message`.
 * `mediaUrl` points at the panel proxy that streams the bytes on demand.
 */
function toMessage(r: {
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

/**
 * Shared SELECT column list + self-join for hydrating a message with its
 * reactions, soft-delete marker and quoted-reply preview. `m` is the messages
 * alias; `rt` is the joined reply-target alias.
 */
const MESSAGE_SELECT = `m.id, m.conversation_id, m.direction, m.body, m.author, m.created_at,
        m.media_type, m.media_mime, m.media_name, m.reactions, m.deleted_at, m.deleted_origin, m.status, m.error_reason,
        rt.id AS reply_to_id, rt.author AS reply_to_author,
        rt.body AS reply_to_body, rt.media_type AS reply_to_media_type`
const MESSAGE_REPLY_JOIN = `LEFT JOIN messages rt ON rt.id = m.reply_to_message_id`

/**
 * Backfill: every message for a manager created strictly after `since`,
 * ordered oldest-first. Used by the SSE route to replay events a browser
 * missed while it was disconnected (gap recovery via Last-Event-ID).
 */
export async function getMessagesSince(
  managerId: string,
  since: Date,
): Promise<
  Array<Message & { contactHandle: string; channelId: string }>
> {
  const rows = await query<
    MessageRow & { channel_id: string; contact_handle: string }
  >(
    `SELECT ${MESSAGE_SELECT}, c.channel_id, c.contact_handle
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     ${MESSAGE_REPLY_JOIN}
     WHERE c.manager_id = $1 AND m.created_at > $2
     ORDER BY m.created_at ASC
     LIMIT 500`,
    [managerId, since.toISOString()],
  )
  return rows.map((r) => ({
    ...toMessage(r),
    channelId: r.channel_id,
    contactHandle: r.contact_handle,
  }))
}

/**
 * Persist an outbound (agent -> contact) message and mark the conversation
 * read. Returns null if the conversation doesn't belong to the manager.
 */
export async function addMessage(input: {
  conversationId: string
  managerId: string
  body: string
  author: string
  /** Optional media descriptor, e.g. an outgoing sticker or WhatsApp file. */
  mediaType?: MediaType
  mediaMime?: string
  mediaName?: string
  /**
   * Small JSON descriptor letting the media proxy re-download the bytes (for an
   * outbound WhatsApp file: `{ waMediaId }`). Nothing binary is stored.
   */
  mediaRef?: Record<string, unknown> | null
  /** Optional quoted-reply target (a message id in the same conversation). */
  replyToMessageId?: string
  /** Conversation-list preview text; defaults to `body` (use for media). */
  preview?: string
}): Promise<Message | null> {
  const owns = await query<{ id: string }>(
    'SELECT id FROM conversations WHERE id = $1 AND manager_id = $2',
    [input.conversationId, input.managerId],
  )
  if (owns.length === 0) return null

  const rows = await query<{ id: string; created_at: string | Date }>(
    `INSERT INTO messages
       (conversation_id, direction, body, author, media_type, media_mime, media_name, media_ref, reply_to_message_id, status)
     VALUES ($1, 'out', $2, $3, $4, $5, $6, $7, $8, 'sent') RETURNING id, created_at`,
    [
      input.conversationId,
      input.body,
      input.author,
      input.mediaType ?? null,
      input.mediaMime ?? null,
      input.mediaName ?? null,
      input.mediaRef ? JSON.stringify(input.mediaRef) : null,
      input.replyToMessageId ?? null,
    ],
  )
  await query(
    'UPDATE conversations SET last_message = $2, last_message_at = now(), unread = 0 WHERE id = $1',
    [input.conversationId, input.preview ?? input.body],
  )
  // Re-read through the standard select so the returned message carries the
  // hydrated reply preview (author/body of the quoted message).
  const full = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT} FROM messages m ${MESSAGE_REPLY_JOIN} WHERE m.id = $1`,
    [rows[0].id],
  )
  return full[0] ? toMessage(full[0]) : null
}

/**
 * Resolve everything the worker needs to act on a specific message (reply /
 * react / delete / forward), scoped to the owning manager. Returns null when
 * the manager doesn't own the message or it has no provider id yet.
 */
export async function getMessageDispatch(
  messageId: string,
  managerId: string,
): Promise<{
  providerMessageId: string | null
  contactHandle: string
  channelId: string
  channelType: ChannelType
  direction: 'in' | 'out'
} | null> {
  const rows = await query<{
    provider_message_id: string | null
    contact_handle: string
    channel_id: string
    type: ChannelType
    direction: 'in' | 'out'
  }>(
    `SELECT m.provider_message_id, c.contact_handle, c.channel_id, ch.type,
            m.direction
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1 AND c.manager_id = $2`,
    [messageId, managerId],
  )
  if (rows.length === 0) return null
  return {
    providerMessageId: rows[0].provider_message_id,
    contactHandle: rows[0].contact_handle,
    channelId: rows[0].channel_id,
    channelType: rows[0].type,
    direction: rows[0].direction,
  }
}

/**
 * Set (or clear, with null) the operator's emoji reaction on a message. Only a
 * single "fromMe" reaction is kept; any contact reactions are preserved.
 * Scoped to the owning manager. Returns true when a row was updated.
 */
export async function setMessageReaction(
  messageId: string,
  managerId: string,
  emoji: string | null,
): Promise<boolean> {
  const owned = await query<{ reactions: unknown }>(
    `SELECT m.reactions FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.manager_id = $2`,
    [messageId, managerId],
  )
  if (owned.length === 0) return false
  const existing: MessageReaction[] = Array.isArray(owned[0].reactions)
    ? (owned[0].reactions as MessageReaction[])
    : []
  const others = existing.filter((r) => !r.fromMe)
  const next = emoji ? [...others, { emoji, fromMe: true }] : others
  await query('UPDATE messages SET reactions = $2 WHERE id = $1', [
    messageId,
    JSON.stringify(next),
  ])
  return true
}

/**
 * Soft-delete a message (sets deleted_at + deleted_origin='self'). The body and
 * any media are PRESERVED so the thread keeps the original content with a
 * "deleted" marker instead of losing it. Scoped to the owning manager. Returns
 * true when a row was updated. Idempotent: only stamps a row that isn't already
 * marked deleted.
 */
export async function markMessageDeleted(
  messageId: string,
  managerId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE messages m
        SET deleted_at = COALESCE(m.deleted_at, now()),
            deleted_origin = 'self'
       FROM conversations c
      WHERE m.conversation_id = c.id
        AND m.id = $1 AND c.manager_id = $2
      RETURNING m.id`,
    [messageId, managerId],
  )
  return rows.length > 0
}

/**
 * Resolve the channel a message belongs to, but only if it is owned by the
 * given manager. Used by the media proxy route to authorize streaming.
 * Returns the channel id + type, or null when the manager doesn't own it.
 */
export async function getMessageOwner(
  messageId: string,
  managerId: string,
): Promise<{ channelId: string; channelType: ChannelType } | null> {
  const rows = await query<{ channel_id: string; type: ChannelType }>(
    `SELECT ch.id AS channel_id, ch.type
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1 AND c.manager_id = $2`,
    [messageId, managerId],
  )
  if (rows.length === 0) return null
  return { channelId: rows[0].channel_id, channelType: rows[0].type }
}

/**
 * Resolve a channel id + type owned by the manager. Used by the sticker proxy
 * routes and sendStickerAction to authorize worker calls.
 */
export async function getChannelOwner(
  channelId: string,
  managerId: string,
): Promise<{ channelId: string; channelType: ChannelType } | null> {
  const rows = await query<{ id: string; type: ChannelType }>(
    'SELECT id, type FROM channels WHERE id = $1 AND manager_id = $2',
    [channelId, managerId],
  )
  if (rows.length === 0) return null
  return { channelId: rows[0].id, channelType: rows[0].type }
}

/**
 * Pin or clear a lead's manual status. Pass null to clear the manual override
 * and fall back to the auto-derived status. Scoped to the owning manager.
 * Returns true when a row was updated.
 */
export async function setConversationStatus(
  conversationId: string,
  managerId: string,
  status: LeadStatus | null,
  detail: NotLiquidReason | null = null,
): Promise<boolean> {
  // The reason sub-status only applies to «Не ликвид»; ignore it otherwise so
  // we never violate the conversations_status_detail_check constraint.
  const effectiveDetail = status === 'not_liquid' ? detail : null
  // $3/$4 are cast to ::text explicitly. Without the cast, Postgres cannot infer
  // the parameter's type when the value is NULL (it only appears in SET / CASE
  // WHEN ... IS NULL), which throws "could not determine data type of parameter".
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET status = $3::text,
            status_detail = $4::text,
            status_updated_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [conversationId, managerId, status, effectiveDetail],
  )
  return rows.length > 0
}

/**
 * Manager: mark a conversation as "no reply needed" by stamping the dismissal
 * time. The thread stops counting as awaiting a reply until a newer inbound
 * message arrives. Pass `clear` to undo (set back to NULL). Scoped to the owner.
 */
export async function dismissReplyReminder(
  conversationId: string,
  managerId: string,
  clear = false,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET reply_dismissed_at = ${clear ? 'NULL' : 'now()'}
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [conversationId, managerId],
  )
  return rows.length > 0
}

/**
 * Manager: mute (silence) or unmute a conversation. A muted thread sends no push
 * notifications, is hidden from the default inbox list and excluded from the
 * "awaiting reply" sorting/reminders. Scoped to the owning manager.
 */
export async function setConversationMuted(
  conversationId: string,
  managerId: string,
  muted: boolean,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET muted = $3
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [conversationId, managerId, muted],
  )
  return rows.length > 0
}

/** True when this conversation is muted. Used by the push dispatcher. */
export async function isConversationMuted(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ muted: boolean }>(
    `SELECT muted FROM conversations WHERE id = $1`,
    [conversationId],
  )
  return rows.length > 0 ? Boolean(rows[0].muted) : false
}

/* ------------------------- Conversation transfer ------------------------- */

export interface TransferTarget {
  id: string
  name: string
  /** True when the colleague is on lunch (still selectable, shown greyed). */
  onLunch: boolean
}

/**
 * Active managers a conversation can be handed off to, excluding the caller and
 * any blocked accounts. On-lunch managers are still returned (a manual transfer
 * is an explicit choice) but flagged so the UI can de-emphasise them.
 */
export async function listTransferTargets(
  excludeManagerId: string,
): Promise<TransferTarget[]> {
  const rows = await query<{
    id: string
    name: string
    on_lunch: boolean | null
  }>(
    `SELECT id, name, on_lunch
       FROM managers
      WHERE status = 'active' AND id <> $1
      ORDER BY on_lunch ASC, name ASC`,
    [excludeManagerId],
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    onLunch: r.on_lunch ?? false,
  }))
}

/**
 * Hand a conversation off to another manager. Ownership-scoped: only the
 * current owner (fromManagerId) can transfer, which also prevents transferring
 * a thread you can't see. Clears the "reply dismissed" marker so the new owner
 * sees it as awaiting a reply, and records an audit row (best-effort: the
 * transfer still succeeds if migration 041 hasn't been applied yet).
 */
export async function transferConversation(input: {
  conversationId: string
  fromManagerId: string
  toManagerId: string
  note?: string
}): Promise<boolean> {
  // Guard: the target must be an existing active manager (and not the caller).
  const target = await query<{ id: string }>(
    `SELECT id FROM managers WHERE id = $1 AND status = 'active'`,
    [input.toManagerId],
  )
  if (target.length === 0 || input.toManagerId === input.fromManagerId) {
    return false
  }

  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET manager_id = $3, reply_dismissed_at = NULL
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [input.conversationId, input.fromManagerId, input.toManagerId],
  )
  if (rows.length === 0) return false

  try {
    await query(
      `INSERT INTO conversation_transfers
         (conversation_id, from_manager_id, to_manager_id, note)
       VALUES ($1, $2, $3, $4)`,
      [
        input.conversationId,
        input.fromManagerId,
        input.toManagerId,
        (input.note ?? '').slice(0, 500),
      ],
    )
  } catch (err) {
    // Audit table missing (pre-041) — don't fail the actual hand-off.
    console.error('[v0] transfer audit skipped:', err)
  }
  return true
}

/* ----------------------------- Live chat ---------------------------- */

export interface LivechatChannel {
  id: string
  /** Owning manager, or NULL once that manager has been deleted. */
  managerId: string | null
  domain: string
  apiKey: string
  /**
   * Integration lifecycle (single source of truth, channels.status):
   *   'pending'   -> created in the admin, the widget has never connected from
   *                  the live site yet (shown as "Not integrated").
   *   'connected' -> the widget has successfully handshaked from the site
   *                  (shown as "Active"). Set by markLivechatConnected.
   */
  status: ChannelStatus
  /** Ordered manager pool that shares this site's conversations (round-robin). */
  pool: string[]
}

/**
 * Single source of truth for "is this widget integrated / live?". True only
 * once the widget has actually connected from the site (status 'connected').
 * Merely creating the channel in the admin keeps it 'pending' = not yet
 * integrated, so the admin never shows a false "Active".
 */
export function isLivechatConnected(
  channel: Pick<LivechatChannel, 'status'>,
): boolean {
  return channel.status === 'connected'
}

/**
 * Mark a live-chat channel as connected the first time its widget handshakes
 * from the live site. Idempotent and cheap: only writes when the status would
 * actually change, flipping 'pending' (or 'error'/'disconnected') to
 * 'connected' and stamping last_checked_at. This is what drives the admin's
 * pending -> active transition.
 */
export async function markLivechatConnected(channelId: string): Promise<void> {
  await query(
    `UPDATE channels
        SET status = 'connected', last_checked_at = now()
      WHERE id = $1 AND type = 'livechat' AND status <> 'connected'`,
    [channelId],
  )
}

/**
 * Resolve a manager that can actually take a new live-chat visitor: the first
 * still-existing id from the pool, falling back to the channel owner. Returns
 * null when nobody is available (all managers deleted) so the caller can show
 * a "no agents" message instead of violating the conversations FK.
 */
export async function resolveLivechatAgentId(
  channel: Pick<LivechatChannel, 'pool' | 'managerId'>,
): Promise<string | null> {
  const candidates = Array.from(
    new Set(
      [...channel.pool, channel.managerId ?? '']
        .map((v) => String(v ?? '').trim())
        .filter(Boolean),
    ),
  )
  if (candidates.length === 0) return null
  const alive = await query<{ id: string }>(
    'SELECT id FROM managers WHERE id = ANY($1::uuid[]) LIMIT 1',
    [candidates],
  )
  return alive[0]?.id ?? null
}

/** Read an ordered, de-duplicated manager pool out of a channel config blob. */
function readPool(
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

/* --------------------------- Lunch / availability -------------------------- */

/** Named round-robin counter used to spread substituted conversations. */
const LUNCH_RR_COUNTER = 'lunch_substitute'

/** Set/clear the calling manager's "on lunch" availability flag. */
export async function setManagerOnLunch(
  managerId: string,
  onLunch: boolean,
): Promise<void> {
  await query('UPDATE managers SET on_lunch = $2 WHERE id = $1', [
    managerId,
    onLunch,
  ])
}

/**
 * Count managers currently AVAILABLE to take new conversations: active and not
 * on lunch. Used to guarantee at least one manager always stays online — the
 * last available manager can't go on lunch.
 */
export async function countAvailableManagers(): Promise<number> {
  try {
    const rows = await query<{ n: string | number }>(
      `SELECT count(*)::int AS n FROM managers
        WHERE status = 'active' AND on_lunch = false`,
    )
    return Number(rows[0]?.n ?? 0)
  } catch (err) {
    console.error('[v0] countAvailableManagers failed (migration 034?):', err)
    // Fail open: if we can't count, don't trap a manager off-lunch.
    return 99
  }
}

/** Read a single manager's current "on lunch" flag (false if not found). */
export async function getManagerOnLunch(managerId: string): Promise<boolean> {
  try {
    const rows = await query<{ on_lunch: boolean }>(
      'SELECT on_lunch FROM managers WHERE id = $1 LIMIT 1',
      [managerId],
    )
    return rows[0]?.on_lunch ?? false
  } catch (err) {
    // Tolerate the column not existing yet (migration 034 not applied) so the
    // panel keeps working until the DB is migrated.
    console.error('[v0] getManagerOnLunch failed (migration 034?):', err)
    return false
  }
}

/**
 * Decide who should HANDLE a brand-new conversation, accounting for lunch
 * breaks. If the natural owner (`ownerId`) is active and not on lunch, they
 * keep it. Otherwise we round-robin across all OTHER active managers who are
 * available right now, so the customer isn't left waiting. When nobody else is
 * free we fall back to the owner (better a delayed reply than a dropped one).
 *
 * Only affects NEW conversations — existing ones are never reassigned, so a
 * manager returning from lunch keeps whatever the substitute already picked up.
 *
 * Safe to call from both ingest paths (app-side webhooks and the worker).
 */
export async function applyLunchSubstitution(
  ownerId: string | null,
): Promise<string | null> {
  if (!ownerId) return ownerId

  try {
    // Is the natural owner available? (exists, active, not on lunch)
    const ownerRows = await query<{ id: string }>(
      `SELECT id FROM managers
        WHERE id = $1 AND status = 'active' AND on_lunch = false
        LIMIT 1`,
      [ownerId],
    )
    if (ownerRows[0]) return ownerId

    // Owner is away — gather available substitutes (active, not on lunch, not
    // the owner), ordered deterministically so the round-robin cursor is stable.
    const subs = await query<{ id: string }>(
      `SELECT id FROM managers
        WHERE status = 'active' AND on_lunch = false AND id <> $1::uuid
        ORDER BY id ASC`,
      [ownerId],
    )
    if (subs.length === 0) return ownerId // nobody free — owner keeps it
    if (subs.length === 1) return subs[0].id

    const idx = await nextRoundRobinIndex(LUNCH_RR_COUNTER)
    return subs[idx % subs.length].id
  } catch (err) {
    // If the on_lunch column isn't there yet (migration 034 not applied), keep
    // the owner so inbound routing never breaks.
    console.error('[v0] applyLunchSubstitution failed (migration 034?):', err)
    return ownerId
  }
}

/**
 * Resolve a live-chat channel by its public API key. Used by the website widget
 * endpoints (ingest + stream) which authenticate with the key, not a session.
 */
export async function getLivechatChannelByApiKey(
  apiKey: string,
): Promise<LivechatChannel | null> {
  if (!apiKey) return null
  const rows = await query<ChannelRow>(
    `SELECT * FROM channels
       WHERE type = 'livechat' AND config->>'apiKey' = $1
       LIMIT 1`,
    [apiKey],
  )
  const c = rows[0]
  if (!c) return null
  const config = (c.config ?? {}) as {
    domain?: string
    apiKey?: string
    pool?: unknown
  }
  return {
    id: c.id,
    managerId: c.manager_id,
    domain: String(config.domain ?? ''),
    apiKey,
    status: c.status,
    pool: readPool(config, c.manager_id),
  }
}

/**
 * Resolve a live-chat channel AND its fully-merged widget config by API key.
 * Used by the public config endpoint the widget polls. Returns the channel
 * (for CORS/origin checks) plus the resolved per-site config with global
 * defaults applied.
 */
export async function getLivechatWidgetConfigByApiKey(
  apiKey: string,
): Promise<{ channel: LivechatChannel; widget: LivechatWidgetConfig } | null> {
  if (!apiKey) return null
  const [rows, globals] = await Promise.all([
    query<ChannelRow>(
      `SELECT * FROM channels
         WHERE type = 'livechat' AND config->>'apiKey' = $1
         LIMIT 1`,
      [apiKey],
    ),
    getLivechatGlobalDefaults(),
  ])
  const c = rows[0]
  if (!c) return null
  const config = (c.config ?? {}) as {
    domain?: string
    apiKey?: string
    pool?: unknown
    appearance?: Partial<LivechatWidgetAppearance>
    widget?: unknown
  }
  const widget = resolveWidgetConfig(
    mergeLegacyAppearance(config.widget, config.appearance ?? {}),
    globals,
  )
  return {
    channel: {
      id: c.id,
      managerId: c.manager_id,
      domain: String(config.domain ?? ''),
      apiKey,
      status: c.status,
      pool: readPool(config, c.manager_id),
    },
    widget,
  }
}

/**
 * Resolve just the working-hours config for a live-chat channel by id, with
 * global defaults applied. Used by Autopilot to evaluate the "working hours"
 * condition for an inbound live-chat message. Returns null when the channel
 * isn't a live-chat channel or no longer exists.
 */
export async function getLivechatWorkingHoursByChannelId(
  channelId: string,
): Promise<WidgetWorkingHours | null> {
  const [rows, globals] = await Promise.all([
    query<ChannelRow>(
      `SELECT * FROM channels WHERE id = $1 AND type = 'livechat' LIMIT 1`,
      [channelId],
    ),
    getLivechatGlobalDefaults(),
  ])
  const c = rows[0]
  if (!c) return null
  const config = (c.config ?? {}) as {
    appearance?: Partial<LivechatWidgetAppearance>
    widget?: unknown
  }
  const widget = resolveWidgetConfig(
    mergeLegacyAppearance(config.widget, config.appearance ?? {}),
    globals,
  )
  return widget.workingHours
}

/**
 * Atomically pick the next manager from a live-chat channel's pool using a
 * round-robin cursor stored in channels.config.rrCursor.
 *
 * The UPDATE takes a row lock on the channel, so visitors arriving in parallel
 * are serialized by Postgres — the cursor increments once per assignment and no
 * manager is ever skipped or double-picked. Falls back to a valid pool member
 * (or the channel owner) if the computed manager no longer exists.
 */
async function assignManagerRoundRobin(
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
function sanitizeConversationMeta(
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
 * Persist an inbound live-chat message from a website visitor, creating or
 * updating the conversation keyed by the visitor handle. The INSERT triggers
 * fire pg_notify('realtime', ...) so the agent inbox updates instantly. Returns
 * the conversation id and the stored message.
 */
/**
 * Resolve the existing live-chat conversation for a (channel, visitor) pair —
 * just its id + assigned manager. Returns null when the visitor hasn't sent a
 * first message yet (no conversation, so no manager to route a typing ping to).
 * Cheap lookup used by the ephemeral typing endpoint; never creates anything.
 */
export async function getLivechatConversationRef(
  channelId: string,
  contactHandle: string,
): Promise<{ id: string; managerId: string } | null> {
  const rows = await query<{ id: string; manager_id: string }>(
    `SELECT id, manager_id FROM conversations
       WHERE channel_id = $1 AND contact_handle = $2
       ORDER BY last_message_at DESC LIMIT 1`,
    [channelId, contactHandle],
  )
  const r = rows[0]
  return r ? { id: r.id, managerId: r.manager_id } : null
}

export async function recordLivechatInbound(input: {
  channelId: string
  /** Ordered manager pool for round-robin assignment of NEW visitors. */
  pool: string[]
  /** Channel owner, used when the pool is empty / resolves to nothing. */
  fallbackManagerId: string
  contactName: string
  contactHandle: string
  body: string
  /** Privacy-scoped visitor context (IP, browser, page, locale, …). */
  meta?: ConversationMeta
}): Promise<{ conversationId: string; managerId: string; message: Message }> {
  const now = new Date().toISOString()
  // Only persist fields that are actually present — never store empty keys.
  const cleanMeta = sanitizeConversationMeta(input.meta)

  // Sticky binding: a visitor is keyed by (channel_id, contact_handle). If a
  // conversation already exists we reuse it AND keep its assigned manager, so
  // repeat messages never bounce to a different manager.
  const existing = await query<{ id: string; manager_id: string }>(
    `SELECT id, manager_id FROM conversations
       WHERE channel_id = $1 AND contact_handle = $2
       ORDER BY last_message_at DESC LIMIT 1`,
    [input.channelId, input.contactHandle],
  )

  let conversationId: string
  let managerId: string
  if (existing[0]) {
    conversationId = existing[0].id
    managerId = existing[0].manager_id
    // Merge fresh meta over the stored blob (keeps firstSeen, refreshes
    // ip/page/lastSeen) without wiping anything we already captured.
    const mergedMeta = { ...cleanMeta, lastSeen: now }
    await query(
      `UPDATE conversations
         SET last_message = $2,
             last_message_at = now(),
             unread = unread + 1,
             contact_name = $3,
             meta = COALESCE(meta, '{}'::jsonb) || $4::jsonb
       WHERE id = $1`,
      [conversationId, input.body, input.contactName, JSON.stringify(mergedMeta)],
    )
  } else {
    // New visitor: distribute to the next manager in the pool (round-robin).
    managerId = await assignManagerRoundRobin(
      input.channelId,
      input.pool,
      input.fallbackManagerId,
    )
    // If the picked manager is on lunch, hand this NEW conversation to an
    // available substitute (round-robin). Existing chats are never reassigned.
    managerId = (await applyLunchSubstitution(managerId)) ?? managerId
    // Assign a small, human-readable per-channel ordinal (#1, #2, …) so several
    // anonymous website visitors are distinguishable in the inbox. Atomic upsert
    // so concurrent first-messages never collide. Best-effort: if the seq table
    // isn't there yet (migration 031 not applied) we simply skip the number
    // instead of failing the whole inbound.
    let visitorNo: number | null = null
    try {
      const seq = await query<{ next_no: number }>(
        `INSERT INTO livechat_visitor_seq (channel_id, next_no)
         VALUES ($1, 1)
         ON CONFLICT (channel_id)
         DO UPDATE SET next_no = livechat_visitor_seq.next_no + 1,
                       updated_at = now()
         RETURNING next_no`,
        [input.channelId],
      )
      visitorNo = seq[0]?.next_no ?? null
    } catch (err) {
      console.error('[v0] recordLivechatInbound: visitor seq unavailable:', err)
    }
    const firstMeta = { ...cleanMeta, firstSeen: now, lastSeen: now }
    const created = await query<{ id: string }>(
      `INSERT INTO conversations
         (channel_id, manager_id, channel_type, contact_name, contact_handle, last_message, last_message_at, unread, meta, visitor_no)
       VALUES ($1, $2, 'livechat', $3, $4, $5, now(), 1, $6::jsonb, $7)
       RETURNING id`,
      [
        input.channelId,
        managerId,
        input.contactName,
        input.contactHandle,
        input.body,
        JSON.stringify(firstMeta),
        visitorNo,
      ],
    )
    conversationId = created[0].id
  }

  const msg = await query<{ id: string; created_at: string | Date }>(
    `INSERT INTO messages (conversation_id, direction, body, author)
     VALUES ($1, 'in', $2, $3) RETURNING id, created_at`,
    [conversationId, input.body, input.contactName],
  )

  return {
    conversationId,
    managerId,
    message: {
      id: msg[0].id,
      conversationId,
      direction: 'in',
      body: input.body,
      author: input.contactName,
      createdAt: new Date(msg[0].created_at).toISOString(),
    },
  }
}

/**
 * Persist a live-chat message that arrived when there was NO manager to route
 * it to (every manager removed from the channel). Keeps the lead instead of
 * dropping it. Best-effort: if the table isn't there yet (migration 037 not
 * applied) we log and swallow so ingestion never hard-fails on this path.
 */
export async function recordLivechatPendingLead(input: {
  channelId: string
  contactName: string
  contactHandle: string
  body: string
  meta?: ConversationMeta
}): Promise<void> {
  try {
    await query(
      `INSERT INTO livechat_pending_leads
         (channel_id, contact_name, contact_handle, body, meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.channelId,
        input.contactName,
        input.contactHandle,
        input.body,
        JSON.stringify(sanitizeConversationMeta(input.meta)),
      ],
    )
  } catch (err) {
    console.error('[v0] recordLivechatPendingLead failed (migration 037?):', err)
  }
}

/**
 * Full message history for a single live-chat visitor (both directions), used
 * to hydrate the widget when it reconnects. Scoped by channel + visitor handle
 * so a visitor can only ever read their own thread.
 */
export async function listVisitorMessages(
  channelId: string,
  contactHandle: string,
): Promise<Message[]> {
  const rows = await query<{
    id: string
    conversation_id: string
    direction: 'in' | 'out'
    body: string
    author: string
    created_at: string | Date
  }>(
    `SELECT m.id, m.conversation_id, m.direction, m.body, m.author, m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1 AND c.contact_handle = $2
      ORDER BY m.created_at ASC
      LIMIT 200`,
    [channelId, contactHandle],
  )
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    direction: r.direction,
    body: r.body,
    author: r.author,
    createdAt: new Date(r.created_at).toISOString(),
  }))
}

/* ------------------------------- MAX -------------------------------- */

/**
 * A connected MAX bot channel, with its secrets decrypted for server-side use.
 * The bot token and webhook secret are stored encrypted in `config`.
 */
export interface MaxChannel {
  id: string
  managerId: string | null
  /** Decrypted MAX bot token (Authorization for botapi.max.ru). */
  token: string
  /** Decrypted webhook secret, validated against X-Max-Bot-Api-Secret. */
  webhookSecret: string
  status: ChannelStatus
  pool: string[]
}

/** Decode a MAX channel row into a usable channel (decrypting its secrets). */
function toMaxChannel(r: ChannelRow): MaxChannel | null {
  const config = (r.config ?? {}) as {
    token?: string
    webhookSecret?: string
    pool?: unknown
  }
  if (!config.token || !config.webhookSecret) return null
  let token: string
  let webhookSecret: string
  try {
    token = decrypt(config.token)
    webhookSecret = decrypt(config.webhookSecret)
  } catch (err) {
    console.error('[v0] toMaxChannel: failed to decrypt secrets:', err)
    return null
  }
  return {
    id: r.id,
    managerId: r.manager_id,
    token,
    webhookSecret,
    status: r.status,
    pool: readPool(config, r.manager_id),
  }
}

/**
 * Resolve a MAX channel by id (no manager scope — the webhook authenticates
 * with the per-channel secret, not a session). Returns null when the channel
 * isn't a MAX channel, doesn't exist, or its secrets can't be decrypted.
 */
export async function getMaxChannelById(
  channelId: string,
): Promise<MaxChannel | null> {
  const rows = await query<ChannelRow>(
    `SELECT * FROM channels WHERE id = $1 AND type = 'max' LIMIT 1`,
    [channelId],
  )
  return rows[0] ? toMaxChannel(rows[0]) : null
}

/**
 * Same as resolveLivechatAgentId but for MAX channels: pick a live manager from
 * the channel's pool (or its owner) to route a new contact to.
 */
export async function resolveMaxAgentId(
  channel: Pick<MaxChannel, 'pool' | 'managerId'>,
): Promise<string | null> {
  return resolveLivechatAgentId(channel)
}

/**
 * Persist an inbound message that arrived via a webhook-style channel (MAX or
 * WhatsApp Cloud), creating or reusing the conversation keyed by the sender's
 * handle. Mirrors recordLivechatInbound: sticky manager binding, round-robin
 * assignment for new contacts, de-dupe on provider_message_id (so webhook
 * retries don't double-insert), and the INSERT fires the realtime NOTIFY so the
 * inbox updates instantly.
 *
 * Returns `null` for the message when the provider_message_id was already seen
 * (duplicate webhook delivery) so callers can skip re-running the autopilot.
 */
export async function recordWebhookInbound(input: {
  channelType: ChannelType
  channelId: string
  pool: string[]
  fallbackManagerId: string
  contactName: string
  /** Sender handle (MAX user_id or WhatsApp wa_id) — used to address replies. */
  contactHandle: string
  body: string
  /** Provider message id for de-dupe / read receipts. */
  providerMessageId?: string | null
  /** Optional media descriptor (e.g. an inbound WhatsApp photo/voice/document). */
  mediaType?: MediaType | null
  mediaMime?: string | null
  mediaName?: string | null
  /**
   * Small JSON descriptor letting the media proxy re-download the bytes on
   * demand (for WhatsApp: `{ waMediaId }`). Nothing binary is stored.
   */
  mediaRef?: Record<string, unknown> | null
  /**
   * Provider id of the message this one quotes (WhatsApp `context.id`). Resolved
   * to a local row and stored as reply_to_message_id when found.
   */
  replyToProviderId?: string | null
  /**
   * Conversation-list preview text. Defaults to `body`; pass a label like
   * "[Фото]" for media so the inbox list isn't blank when there's no caption.
   */
  preview?: string
}): Promise<{
  conversationId: string
  managerId: string
  message: Message | null
}> {
  // De-dupe: if we've already stored this provider message id, bail early.
  if (input.providerMessageId) {
    const dup = await query<{ id: string; conversation_id: string }>(
      `SELECT m.id, m.conversation_id
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.channel_id = $1 AND m.provider_message_id = $2
        LIMIT 1`,
      [input.channelId, input.providerMessageId],
    )
    if (dup[0]) {
      const conv = await query<{ manager_id: string }>(
        `SELECT manager_id FROM conversations WHERE id = $1`,
        [dup[0].conversation_id],
      )
      return {
        conversationId: dup[0].conversation_id,
        managerId: conv[0]?.manager_id ?? input.fallbackManagerId,
        message: null,
      }
    }
  }

  // Conversation-list preview: caption for media, else the text body.
  const preview = input.preview ?? input.body

  const existing = await query<{ id: string; manager_id: string }>(
    `SELECT id, manager_id FROM conversations
       WHERE channel_id = $1 AND contact_handle = $2
       ORDER BY last_message_at DESC LIMIT 1`,
    [input.channelId, input.contactHandle],
  )

  let conversationId: string
  let managerId: string
  if (existing[0]) {
    conversationId = existing[0].id
    managerId = existing[0].manager_id
    await query(
      `UPDATE conversations
         SET last_message = $2,
             last_message_at = now(),
             unread = unread + 1,
             contact_name = $3
       WHERE id = $1`,
      [conversationId, preview, input.contactName],
    )
  } else {
    managerId = await assignManagerRoundRobin(
      input.channelId,
      input.pool,
      input.fallbackManagerId,
    )
    // Route NEW contacts away from a manager who is on lunch to an available
    // substitute. Existing conversations keep their assigned manager above.
    managerId = (await applyLunchSubstitution(managerId)) ?? managerId
    const created = await query<{ id: string }>(
      `INSERT INTO conversations
         (channel_id, manager_id, channel_type, contact_name, contact_handle, last_message, last_message_at, unread)
       VALUES ($1, $2, $3, $4, $5, $6, now(), 1)
       RETURNING id`,
      [
        input.channelId,
        managerId,
        input.channelType,
        input.contactName,
        input.contactHandle,
        preview,
      ],
    )
    conversationId = created[0].id
  }

  // Resolve a quoted-reply link from the provider id of the quoted message.
  let replyToMessageId: string | null = null
  if (input.replyToProviderId) {
    const rt = await query<{ id: string }>(
      `SELECT m.id FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.channel_id = $1 AND m.provider_message_id = $2
        LIMIT 1`,
      [input.channelId, input.replyToProviderId],
    )
    replyToMessageId = rt[0]?.id ?? null
  }

  const msg = await query<{ id: string; created_at: string | Date }>(
    `INSERT INTO messages
       (conversation_id, direction, body, author, provider_message_id,
        media_type, media_mime, media_name, media_ref, reply_to_message_id)
     VALUES ($1, 'in', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, created_at`,
    [
      conversationId,
      input.body,
      input.contactName,
      input.providerMessageId ?? null,
      input.mediaType ?? null,
      input.mediaMime ?? null,
      input.mediaName ?? null,
      input.mediaRef ? JSON.stringify(input.mediaRef) : null,
      replyToMessageId,
    ],
  )

  // Re-read through the standard select so the returned message carries media
  // url + hydrated reply preview (used by the autopilot / realtime echo).
  const full = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT} FROM messages m ${MESSAGE_REPLY_JOIN} WHERE m.id = $1`,
    [msg[0].id],
  )

  return {
    conversationId,
    managerId,
    message: full[0] ? toMessage(full[0]) : null,
  }
}

/** Back-compat thin wrapper: record an inbound MAX message. */
export async function recordMaxInbound(input: {
  channelId: string
  pool: string[]
  fallbackManagerId: string
  contactName: string
  contactHandle: string
  body: string
  providerMessageId?: string | null
}) {
  return recordWebhookInbound({ channelType: 'max', ...input })
}

/**
 * Resolve what we need to deliver an outbound reply to MAX for a conversation:
 * the decrypted channel (token) plus the contact's numeric user_id. Returns
 * null when the conversation isn't a MAX conversation. No manager scope — used
 * by the autopilot (which runs server-side after ingestion) and the send action
 * (which has already authorized the manager).
 */
export async function getMaxDispatchByConversationId(
  conversationId: string,
): Promise<{
  channel: MaxChannel
  contactHandle: string
  proxy: ProxyDescriptor | null
} | null> {
  const rows = await query<{ channel_id: string; contact_handle: string }>(
    `SELECT c.channel_id, c.contact_handle
       FROM conversations c
       JOIN channels ch ON ch.id = c.channel_id
      WHERE c.id = $1 AND ch.type = 'max'
      LIMIT 1`,
    [conversationId],
  )
  const r = rows[0]
  if (!r) return null
  const channel = await getMaxChannelById(r.channel_id)
  if (!channel) return null
  const proxy = await getProxyForChannel(r.channel_id)
  return { channel, contactHandle: r.contact_handle, proxy }
}

/* ------------------------------- VK -------------------------------- */

/**
 * A connected VK community channel, with its secrets decrypted for server-side
 * use. The community access token and the Callback API webhook secret are stored
 * encrypted in `config`; the numeric group id + callback server id are stored in
 * plaintext (non-secret) so we can manage/clean up the callback server.
 */
export interface VkChannel {
  id: string
  managerId: string | null
  /** Decrypted VK community access token (for api.vk.com). */
  token: string
  /** Decrypted webhook secret, validated against the `secret` field VK sends. */
  webhookSecret: string
  /** Confirmation string echoed back on the Callback API handshake. */
  confirmationCode: string
  /** Numeric VK community (group) id. */
  groupId: number
  /** VK-assigned Callback API server id (null until registration completes). */
  serverId: number | null
  status: ChannelStatus
  pool: string[]
}

/** Decode a VK channel row into a usable channel (decrypting its secrets). */
function toVkChannel(r: ChannelRow): VkChannel | null {
  const config = (r.config ?? {}) as {
    token?: string
    webhookSecret?: string
    confirmationCode?: string
    groupId?: number
    serverId?: number
    pool?: unknown
  }
  if (!config.token || !config.webhookSecret || !config.confirmationCode) {
    return null
  }
  let token: string
  let webhookSecret: string
  try {
    token = decrypt(config.token)
    webhookSecret = decrypt(config.webhookSecret)
  } catch (err) {
    console.error('[v0] toVkChannel: failed to decrypt secrets:', err)
    return null
  }
  return {
    id: r.id,
    managerId: r.manager_id,
    token,
    webhookSecret,
    confirmationCode: config.confirmationCode,
    groupId: Number(config.groupId ?? 0),
    serverId: config.serverId != null ? Number(config.serverId) : null,
    status: r.status,
    pool: readPool(config, r.manager_id),
  }
}

/**
 * Resolve a VK channel by id (no manager scope — the webhook authenticates with
 * the per-channel secret, not a session). Returns null when the channel isn't a
 * VK channel, doesn't exist, or its secrets can't be decrypted.
 */
export async function getVkChannelById(
  channelId: string,
): Promise<VkChannel | null> {
  const rows = await query<ChannelRow>(
    `SELECT * FROM channels WHERE id = $1 AND type = 'vk' LIMIT 1`,
    [channelId],
  )
  return rows[0] ? toVkChannel(rows[0]) : null
}

/**
 * Same as resolveLivechatAgentId but for VK channels: pick a live manager from
 * the channel's pool (or its owner) to route a new contact to.
 */
export async function resolveVkAgentId(
  channel: Pick<VkChannel, 'pool' | 'managerId'>,
): Promise<string | null> {
  return resolveLivechatAgentId(channel)
}

/** Back-compat thin wrapper: record an inbound VK message. */
export async function recordVkInbound(input: {
  channelId: string
  pool: string[]
  fallbackManagerId: string
  contactName: string
  contactHandle: string
  body: string
  providerMessageId?: string | null
  preview?: string
  mediaType?: MediaType | null
  mediaMime?: string | null
  mediaName?: string | null
  mediaRef?: Record<string, unknown> | null
}) {
  return recordWebhookInbound({ channelType: 'vk', ...input })
}

/**
 * Resolve what we need to deliver an outbound reply to VK for a conversation:
 * the decrypted channel (token) plus the contact's numeric user id. Returns null
 * when the conversation isn't a VK conversation. No manager scope — used by the
 * autopilot (server-side after ingestion) and the send action (which has already
 * authorized the manager).
 */
export async function getVkDispatchByConversationId(
  conversationId: string,
): Promise<{
  channel: VkChannel
  contactHandle: string
  proxy: ProxyDescriptor | null
} | null> {
  const rows = await query<{ channel_id: string; contact_handle: string }>(
    `SELECT c.channel_id, c.contact_handle
       FROM conversations c
       JOIN channels ch ON ch.id = c.channel_id
      WHERE c.id = $1 AND ch.type = 'vk'
      LIMIT 1`,
    [conversationId],
  )
  const r = rows[0]
  if (!r) return null
  const channel = await getVkChannelById(r.channel_id)
  if (!channel) return null
  const proxy = await getProxyForChannel(r.channel_id)
  return { channel, contactHandle: r.contact_handle, proxy }
}

/* ------------------------- WhatsApp Cloud API ------------------------- */

/**
 * App-level WhatsApp Cloud API configuration.
 *
 * With the official Cloud API a single Meta app owns ONE access token, ONE app
 * secret and ONE webhook (callback URL + verify token) — all shared by every
 * phone number under the WhatsApp Business Account. So the admin configures this
 * once; individual phone numbers are then added as `whatsapp` channel rows and
 * assigned to managers (see WhatsappNumber below). This replaces the old
 * per-manager connect flow where each channel carried its own token.
 *
 * Stored under app_settings key `whatsapp_app`. The access token and app secret
 * are encrypted; the verify token is kept in plaintext because it is non-secret
 * (it only gates the webhook handshake echo) and must be shown to the admin to
 * paste into Meta.
 */
export interface WhatsappAppConfig {
  /** Decrypted permanent access token (Bearer for graph.facebook.com). */
  accessToken: string
  /** Decrypted app secret for X-Hub-Signature-256 verification, or null. */
  appSecret: string | null
  /** Verify token compared on the webhook GET handshake. */
  verifyToken: string
  /** WhatsApp Business Account id, used to auto-import phone numbers. */
  wabaId: string | null
}

const WHATSAPP_APP_KEY = 'whatsapp_app'

interface WhatsappAppConfigRow {
  accessToken?: string
  appSecret?: string | null
  verifyToken?: string
  wabaId?: string | null
}

async function readWhatsappAppRow(): Promise<WhatsappAppConfigRow | null> {
  const rows = await query<{ value: WhatsappAppConfigRow }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [WHATSAPP_APP_KEY],
  )
  return rows[0]?.value ?? null
}

async function writeWhatsappAppRow(value: WhatsappAppConfigRow): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WHATSAPP_APP_KEY, JSON.stringify(value)],
  )
}

/**
 * Read + decrypt the app-level WhatsApp config. Null when the access token has
 * not been saved yet — i.e. the app can't send/import. Note the webhook can
 * still work before this (see getWhatsappWebhookSecrets / the verify token is
 * provisioned independently), so the admin can register the webhook in Meta
 * first and add a working token afterwards.
 */
export async function getWhatsappAppConfig(): Promise<WhatsappAppConfig | null> {
  const v = await readWhatsappAppRow()
  if (!v?.accessToken || !v.verifyToken) return null
  try {
    return {
      accessToken: decrypt(v.accessToken),
      appSecret: v.appSecret ? decrypt(v.appSecret) : null,
      verifyToken: v.verifyToken,
      wabaId: v.wabaId ?? null,
    }
  } catch (err) {
    console.error('[v0] getWhatsappAppConfig: decrypt failed:', err)
    return null
  }
}

/**
 * What the webhook handlers need — independent of the access token. The verify
 * token gates the GET handshake; the app secret (if set) verifies POST
 * signatures. Returns null verifyToken only when the webhook was never
 * initialized.
 */
export async function getWhatsappWebhookSecrets(): Promise<{
  verifyToken: string | null
  appSecret: string | null
}> {
  const v = await readWhatsappAppRow()
  if (!v) return { verifyToken: null, appSecret: null }
  let appSecret: string | null = null
  try {
    appSecret = v.appSecret ? decrypt(v.appSecret) : null
  } catch (err) {
    console.error('[v0] getWhatsappWebhookSecrets: decrypt failed:', err)
  }
  return { verifyToken: v.verifyToken ?? null, appSecret }
}

/**
 * Ensure a verify token exists (generating + persisting one on first call) and
 * return it. This lets the admin configure the Meta webhook BEFORE entering a
 * working access token, breaking the chicken-and-egg where verification failed
 * because nothing was saved yet.
 */
export async function ensureWhatsappVerifyToken(): Promise<string> {
  const v = (await readWhatsappAppRow()) ?? {}
  if (v.verifyToken) return v.verifyToken
  const verifyToken = randomBytes(24).toString('hex')
  await writeWhatsappAppRow({ ...v, verifyToken })
  return verifyToken
}

/** Non-secret view of the app config for admin display. */
export interface WhatsappAppStatus {
  /** Access token saved — app can send/import numbers. */
  configured: boolean
  /** Verify token exists — the Meta webhook can be registered/verified. */
  webhookReady: boolean
  hasAppSecret: boolean
  verifyToken: string | null
  wabaId: string | null
  tokenMask: string | null
}

/** Admin: read the app config status without exposing the raw secrets. */
export async function getWhatsappAppStatus(): Promise<WhatsappAppStatus> {
  const v = await readWhatsappAppRow()
  let tokenMask: string | null = null
  if (v?.accessToken) {
    try {
      tokenMask = maskSecret(decrypt(v.accessToken))
    } catch {
      tokenMask = null
    }
  }
  return {
    configured: Boolean(v?.accessToken && v.verifyToken),
    webhookReady: Boolean(v?.verifyToken),
    hasAppSecret: Boolean(v?.appSecret),
    verifyToken: v?.verifyToken ?? null,
    wabaId: v?.wabaId ?? null,
    tokenMask,
  }
}

/**
 * Admin: persist the app-level WhatsApp config. The verify token is preserved
 * across saves (so a re-saved webhook keeps working) and generated on first
 * save. An empty appSecret clears it.
 */
export async function saveWhatsappAppConfig(input: {
  accessToken: string
  appSecret: string | null
  wabaId: string | null
}): Promise<void> {
  const existing = await readWhatsappAppRow()
  const verifyToken = existing?.verifyToken || randomBytes(24).toString('hex')
  await writeWhatsappAppRow({
    accessToken: encrypt(input.accessToken),
    appSecret: input.appSecret ? encrypt(input.appSecret) : null,
    verifyToken,
    wabaId: input.wabaId?.trim() || null,
  })
}

/**
 * A single WhatsApp phone number managed under the Cloud API app. Each number is
 * a `channels` row (type='whatsapp', config.provider='cloud') assigned to at
 * most one manager. No secrets live here — token/app-secret are app-level.
 */
export interface WhatsappNumber {
  /** Channel id. */
  id: string
  managerId: string | null
  managerName: string | null
  /** Friendly label shown in the inbox/admin. */
  name: string
  /** Meta phone number id used in the Graph API path + inbound routing. */
  phoneNumberId: string
  /** Human-readable phone (e.g. +1 555 …) for display. */
  displayPhoneNumber: string
  status: ChannelStatus
  createdAt: string
}

function toWhatsappNumber(
  r: ChannelRow & { manager_name?: string | null },
): WhatsappNumber {
  const config = (r.config ?? {}) as {
    phoneNumberId?: string
    displayPhoneNumber?: string
  }
  return {
    id: r.id,
    managerId: r.manager_id,
    managerName: r.manager_name ?? null,
    name: r.name,
    phoneNumberId: config.phoneNumberId ?? '',
    displayPhoneNumber: config.displayPhoneNumber ?? r.detail,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/** Admin: list every WhatsApp number with its assigned manager. */
export async function listWhatsappNumbers(): Promise<WhatsappNumber[]> {
  const rows = await query<ChannelRow & { manager_name: string | null }>(
    `SELECT c.*, m.name AS manager_name
       FROM channels c
       LEFT JOIN managers m ON m.id = c.manager_id
      WHERE c.type = 'whatsapp'
      ORDER BY c.created_at DESC`,
  )
  return rows.map(toWhatsappNumber)
}

/** Look up a number by its Meta phone number id (inbound routing). */
export async function getWhatsappNumberByPhoneId(
  phoneNumberId: string,
): Promise<WhatsappNumber | null> {
  const rows = await query<ChannelRow & { manager_name: string | null }>(
    `SELECT c.*, m.name AS manager_name
       FROM channels c
       LEFT JOIN managers m ON m.id = c.manager_id
      WHERE c.type = 'whatsapp' AND c.config->>'phoneNumberId' = $1
      LIMIT 1`,
    [phoneNumberId],
  )
  return rows[0] ? toWhatsappNumber(rows[0]) : null
}

/**
 * Admin: add a phone number under the app. A number with an assigned manager is
 * `connected`; an unassigned one is `pending` until the admin assigns it.
 */
export async function createWhatsappNumber(input: {
  phoneNumberId: string
  displayPhoneNumber: string
  name: string
  managerId: string | null
}): Promise<WhatsappNumber> {
  const id = randomUUID()
  const rows = await query<ChannelRow>(
    `INSERT INTO channels
       (id, manager_id, type, name, detail, status, session_status, config, last_checked_at)
     VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7, now())
     RETURNING *`,
    [
      id,
      input.managerId,
      input.name,
      input.displayPhoneNumber,
      input.managerId ? 'connected' : 'pending',
      input.managerId ? 'online' : 'offline',
      JSON.stringify({
        provider: 'cloud',
        phoneNumberId: input.phoneNumberId,
        displayPhoneNumber: input.displayPhoneNumber,
      }),
    ],
  )
  return toWhatsappNumber(rows[0])
}

/** Admin: (re)assign a number to a manager, or unassign with null. */
export async function assignWhatsappNumber(
  channelId: string,
  managerId: string | null,
): Promise<void> {
  await query(
    `UPDATE channels
        SET manager_id = $2,
            status = CASE WHEN $2 IS NULL THEN 'pending' ELSE 'connected' END,
            session_status = CASE WHEN $2 IS NULL THEN 'offline' ELSE 'online' END,
            last_checked_at = now()
      WHERE id = $1 AND type = 'whatsapp'`,
    [channelId, managerId],
  )
}

/** Admin: remove a WhatsApp number (and its conversations via FK cascade). */
export async function deleteWhatsappNumber(channelId: string): Promise<void> {
  await query(`DELETE FROM channels WHERE id = $1 AND type = 'whatsapp'`, [
    channelId,
  ])
}

/** Inbound routing target resolved from a webhook's phone_number_id. */
export interface WhatsappInboundRoute {
  channelId: string
  managerId: string | null
  pool: string[]
}

/** Resolve which channel/manager an inbound message belongs to. */
export async function resolveWhatsappInboundByPhoneId(
  phoneNumberId: string,
): Promise<WhatsappInboundRoute | null> {
  const rows = await query<ChannelRow>(
    `SELECT * FROM channels
      WHERE type = 'whatsapp' AND config->>'phoneNumberId' = $1
      LIMIT 1`,
    [phoneNumberId],
  )
  const r = rows[0]
  if (!r) return null
  return {
    channelId: r.id,
    managerId: r.manager_id,
    pool: readPool((r.config ?? {}) as { pool?: unknown }, r.manager_id),
  }
}

/** Pick a live manager from a number's pool (or owner) for a new contact. */
export async function resolveWhatsappAgentId(channel: {
  pool: string[]
  managerId: string | null
}): Promise<string | null> {
  return resolveLivechatAgentId(channel)
}

/**
 * Resolve what we need to deliver an outbound WhatsApp reply: the number's phone
 * id + the app-level access token + the contact's wa_id. Returns null when the
 * conversation isn't a Cloud API WhatsApp conversation or the app is not
 * configured.
 */
export async function getWhatsappCloudDispatchByConversationId(
  conversationId: string,
): Promise<{
  phoneNumberId: string
  token: string
  contactHandle: string
  proxy: ProxyDescriptor | null
} | null> {
  const rows = await query<{
    channel_id: string
    phone_number_id: string | null
    contact_handle: string
  }>(
    `SELECT ch.id AS channel_id, ch.config->>'phoneNumberId' AS phone_number_id, c.contact_handle
       FROM conversations c
       JOIN channels ch ON ch.id = c.channel_id
      WHERE c.id = $1 AND ch.type = 'whatsapp'
      LIMIT 1`,
    [conversationId],
  )
  const r = rows[0]
  if (!r?.phone_number_id) return null
  const app = await getWhatsappAppConfig()
  if (!app) return null
  const proxy = await getProxyForChannel(r.channel_id)
  return {
    phoneNumberId: r.phone_number_id,
    token: app.accessToken,
    contactHandle: r.contact_handle,
    proxy,
  }
}

/**
 * Most recent inbound provider_message_id for a conversation — used to send a
 * WhatsApp read receipt (Cloud API marks a specific message id as read).
 */
export async function getLastInboundProviderId(
  conversationId: string,
): Promise<string | null> {
  const rows = await query<{ provider_message_id: string | null }>(
    `SELECT provider_message_id FROM messages
       WHERE conversation_id = $1 AND direction = 'in'
         AND provider_message_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  )
  return rows[0]?.provider_message_id ?? null
}

/** Record an inbound WhatsApp Cloud message (thin wrapper over the generic). */
export async function recordWhatsappInbound(input: {
  channelId: string
  pool: string[]
  fallbackManagerId: string
  contactName: string
  contactHandle: string
  body: string
  providerMessageId?: string | null
  mediaType?: MediaType | null
  mediaMime?: string | null
  mediaName?: string | null
  mediaRef?: Record<string, unknown> | null
  replyToProviderId?: string | null
  preview?: string
}) {
  return recordWebhookInbound({ channelType: 'whatsapp', ...input })
}

/**
 * Apply a WhatsApp delivery-status webhook event to an outbound message,
 * matched by its provider message id. Status only moves FORWARD
 * (sent → delivered → read); 'failed' is terminal. Scoped to WhatsApp channels
 * so a provider id collision across transports can't cross-update. The realtime
 * trigger fans the change out to the panel (no refetch).
 */
export async function updateWhatsappMessageStatus(
  providerMessageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  reason?: string | null,
): Promise<void> {
  // Rank guards against out-of-order webhooks (read can arrive before delivered).
  const rank: Record<string, number> = {
    sent: 1,
    delivered: 2,
    read: 3,
    failed: 3,
  }
  // On 'failed' record the mapped reason (capped for the NOTIFY budget); any
  // successful forward step clears a stale reason so a delivered/read message
  // never keeps showing an old error string.
  const trimmed =
    status === 'failed' && typeof reason === 'string' && reason.trim()
      ? reason.trim().slice(0, 300)
      : null
  await query(
    `UPDATE messages m
        SET status = $2,
            error_reason = CASE WHEN $2 = 'failed' THEN $4 ELSE NULL END
       FROM conversations c, channels ch
      WHERE m.conversation_id = c.id
        AND ch.id = c.channel_id
        AND ch.type = 'whatsapp'
        AND m.provider_message_id = $1
        AND m.direction = 'out'
        AND (
          m.status IS NULL
          OR $3 > COALESCE(
            CASE m.status
              WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2
              WHEN 'read' THEN 3 WHEN 'failed' THEN 3 END, 0)
          OR $2 = 'failed'
        )`,
    [providerMessageId, status, rank[status], trimmed],
  )
}

/**
 * Media descriptor for the proxy to re-download a WhatsApp message's bytes from
 * the Graph API. Returns the stored WhatsApp media id + mime and the app access
 * token. Null when the message isn't a Cloud WhatsApp media row or the app is
 * not configured. Authorization is enforced separately by getMessageOwner.
 */
export async function getWhatsappMediaDescriptor(
  messageId: string,
): Promise<{ waMediaId: string; mime: string | null; token: string } | null> {
  const rows = await query<{ media_ref: unknown; media_mime: string | null }>(
    `SELECT m.media_ref, m.media_mime
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE m.id = $1 AND ch.type = 'whatsapp'
      LIMIT 1`,
    [messageId],
  )
  const ref = rows[0]?.media_ref as { waMediaId?: string } | null
  if (!ref?.waMediaId) return null
  const app = await getWhatsappAppConfig()
  if (!app) return null
  return { waMediaId: ref.waMediaId, mime: rows[0]?.media_mime ?? null, token: app.accessToken }
}

/**
 * Media descriptor for channels that store a direct CDN url in media_ref (VK
 * photos/docs, and any other webhook channel that keeps a url). Returns the url
 * plus the account's proxy so the media proxy route can stream the bytes from
 * the provider's CDN through the account's dedicated IP. Null when the message
 * has no url ref. Authorization is enforced separately by getMessageOwner.
 */
export async function getUrlMediaDescriptor(
  messageId: string,
): Promise<{ url: string; mime: string | null; proxy: ProxyDescriptor | null } | null> {
  const rows = await query<{
    media_ref: unknown
    media_mime: string | null
    channel_id: string
  }>(
    `SELECT m.media_ref, m.media_mime, c.channel_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1
      LIMIT 1`,
    [messageId],
  )
  const row = rows[0]
  if (!row) return null
  const ref = row.media_ref as { url?: string } | null
  if (!ref?.url) return null
  const proxy = await getProxyForChannel(row.channel_id)
  return { url: ref.url, mime: row.media_mime ?? null, proxy }
}

/** Backfill the provider message id on an outbound row (post-delivery). */
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
 * Flag an outbound row as failed (delivery to the provider was rejected) and
 * store a short, human-readable reason so the panel can show WHY it failed
 * (e.g. VK "user disallowed messages", WhatsApp "24h window closed"). The reason
 * is capped so it can never blow the realtime NOTIFY payload budget.
 */
export async function markMessageFailed(
  messageId: string,
  reason?: string | null,
): Promise<void> {
  const trimmed =
    typeof reason === 'string' && reason.trim()
      ? reason.trim().slice(0, 300)
      : null
  await query(
    `UPDATE messages SET status = 'failed', error_reason = $2 WHERE id = $1`,
    [messageId, trimmed],
  )
}

/* ----------------------- Off-hours messengers ----------------------- */

/**
 * Admin-configured messenger fallbacks shown when the live chat is outside
 * working hours. Telegram links and WhatsApp phone numbers are stored as plain
 * lists; they are handed to visitors in round-robin order at request time.
 */
export interface OffhoursMessengers {
  telegramLinks: string[]
  whatsappPhones: string[]
}

const OFFHOURS_SETTINGS_KEY = 'offhours_messengers'

/** Read the configured messenger lists (always returns a valid shape). */
export async function getOffhoursMessengers(): Promise<OffhoursMessengers> {
  const rows = await query<{ value: OffhoursMessengers }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [OFFHOURS_SETTINGS_KEY],
  )
  const value = rows[0]?.value
  return {
    telegramLinks: Array.isArray(value?.telegramLinks)
      ? value.telegramLinks.filter((v): v is string => typeof v === 'string')
      : [],
    whatsappPhones: Array.isArray(value?.whatsappPhones)
      ? value.whatsappPhones.filter((v): v is string => typeof v === 'string')
      : [],
  }
}

/** Admin: persist the messenger lists (full replace). */
export async function saveOffhoursMessengers(
  input: OffhoursMessengers,
): Promise<void> {
  const value: OffhoursMessengers = {
    telegramLinks: input.telegramLinks.map((v) => v.trim()).filter(Boolean),
    whatsappPhones: input.whatsappPhones.map((v) => v.trim()).filter(Boolean),
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [OFFHOURS_SETTINGS_KEY, JSON.stringify(value)],
  )
}

/**
 * Atomically take the next index from a named round-robin counter. The counter
 * grows forever; callers apply `% length` so distribution wraps around the
 * configured list ("when links run out, continue from the start").
 */
async function nextRoundRobinIndex(name: string): Promise<number> {
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

export interface OffhoursAssignment {
  telegram: string | null
  whatsapp: string | null
}

/**
 * Hand the next messenger links to a visitor in round-robin order: the 1st
 * visitor gets link #1, the 2nd gets #2, and so on, wrapping around when the
 * list is exhausted. Telegram and WhatsApp advance independently.
 */
export async function nextOffhoursAssignment(): Promise<OffhoursAssignment> {
  const { telegramLinks, whatsappPhones } = await getOffhoursMessengers()

  let telegram: string | null = null
  if (telegramLinks.length > 0) {
    const idx = await nextRoundRobinIndex('telegram')
    telegram = telegramLinks[idx % telegramLinks.length] ?? null
  }

  let whatsapp: string | null = null
  if (whatsappPhones.length > 0) {
    const idx = await nextRoundRobinIndex('whatsapp')
    const phone = whatsappPhones[idx % whatsappPhones.length]
    whatsapp = phone ? whatsappLinkFromPhone(phone) : null
  }

  return { telegram, whatsapp }
}

/* ------------------------------ Stats ------------------------------- */

export interface AdminStats {
  totalManagers: number
  activeManagers: number
  blockedManagers: number
  totalChannels: number
  connectedChannels: number
  channelsByType: Record<ChannelType, number>
}

export async function getAdminStats(): Promise<AdminStats> {
  const [managers, channels] = await Promise.all([
    listManagers(),
    listAllChannels(),
  ])
  return {
    totalManagers: managers.length,
    activeManagers: managers.filter((m) => m.status === 'active').length,
    blockedManagers: managers.filter((m) => m.status === 'blocked').length,
    totalChannels: channels.length,
    connectedChannels: channels.filter((c) => c.status === 'connected').length,
    channelsByType: {
      telegram: channels.filter((c) => c.type === 'telegram').length,
      whatsapp: channels.filter((c) => c.type === 'whatsapp').length,
      livechat: channels.filter((c) => c.type === 'livechat').length,
      max: channels.filter((c) => c.type === 'max').length,
      vk: channels.filter((c) => c.type === 'vk').length,
    },
  }
}

export interface ManagerStats {
  totalChannels: number
  connectedChannels: number
  pendingChannels: number
  unreadMessages: number
  openConversations: number
}

export async function getManagerStats(
  managerId: string,
): Promise<ManagerStats> {
  const [channels, conversations] = await Promise.all([
    listChannels(managerId),
    listConversations(managerId),
  ])
  return {
    totalChannels: channels.length,
    connectedChannels: channels.filter((c) => c.status === 'connected').length,
    pendingChannels: channels.filter((c) => c.status === 'pending').length,
    unreadMessages: conversations.reduce((sum, c) => sum + c.unread, 0),
    openConversations: conversations.length,
  }
}

/* ------------------- Lead & messenger analytics -------------------- */

export type GoalMessenger = 'any' | 'telegram' | 'whatsapp'
export type ClickMessenger = 'telegram' | 'whatsapp'

/**
 * SQL expression that derives the EFFECTIVE lead status from a conversation row.
 * Mirrors DEFAULT_LEAD_STATUS so DB-side aggregates match the per-row JS value.
 */
const EFFECTIVE_STATUS_SQL = `COALESCE(status, 'unsubscribed')`

function emptyStatusCounts(): Record<LeadStatus, number> {
  return { unsubscribed: 0, liquid: 0, not_liquid: 0, transferred: 0 }
}

function emptyReasonCounts(): Record<NotLiquidReason, number> {
  return { geo: 0, under18: 0, na: 0, trash: 0 }
}

export interface LeadAnalytics {
  /** Total leads (conversations that wrote in). */
  totalLeads: number
  /** Lead count grouped by effective status. */
  byStatus: Record<LeadStatus, number>
  /** «Не ликвид» lead count grouped by reason sub-status. */
  byReason: Record<NotLiquidReason, number>
  /** Leads whose first message arrived within the last 7 days. */
  newThisWeek: number
  /** Leads with at least one unanswered incoming message. */
  unanswered: number
  /** New leads per day for the last 7 days (oldest first). */
  byDay: { date: string; count: number }[]
}

/**
 * Lead analytics for a manager (or the whole system when managerId is omitted).
 * "New leads per day" uses each conversation's FIRST message timestamp so the
 * dynamics reflect when a contact actually started writing in.
 */
export async function getLeadAnalytics(
  managerId?: string,
): Promise<LeadAnalytics> {
  const scope = managerId ? 'WHERE manager_id = $1' : ''
  const params = managerId ? [managerId] : []

  const [statusRows, reasonRows, totalRows, weekRows, byDayRows] =
    await Promise.all([
    query<{ eff: LeadStatus; n: string }>(
      `SELECT ${EFFECTIVE_STATUS_SQL} AS eff, count(*)::int AS n
         FROM conversations ${scope}
        GROUP BY eff`,
      params,
    ),
    query<{ reason: NotLiquidReason; n: string }>(
      `SELECT status_detail AS reason, count(*)::int AS n
         FROM conversations ${scope ? `${scope} AND` : 'WHERE'}
              status = 'not_liquid' AND status_detail IS NOT NULL
        GROUP BY status_detail`,
      params,
    ),
    query<{ total: string; unanswered: string }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE unread > 0)::int AS unanswered
         FROM conversations ${scope}`,
      params,
    ),
    query<{ n: string }>(
      `SELECT count(*)::int AS n FROM (
         SELECT c.id, MIN(m.created_at) AS first_at
           FROM conversations c
           JOIN messages m ON m.conversation_id = c.id
          ${managerId ? 'WHERE c.manager_id = $1' : ''}
          GROUP BY c.id
       ) t
       WHERE first_at >= now() - interval '7 days'`,
      params,
    ),
    query<{ d: string | Date; n: string }>(
      `SELECT date_trunc('day', first_at) AS d, count(*)::int AS n FROM (
         SELECT c.id, MIN(m.created_at) AS first_at
           FROM conversations c
           JOIN messages m ON m.conversation_id = c.id
          ${managerId ? 'WHERE c.manager_id = $1' : ''}
          GROUP BY c.id
       ) t
       WHERE first_at >= now() - interval '6 days'
       GROUP BY 1
       ORDER BY 1`,
      params,
    ),
  ])

  const byStatus = emptyStatusCounts()
  for (const r of statusRows) {
    if (r.eff in byStatus) byStatus[r.eff] = Number(r.n)
  }

  const byReason = emptyReasonCounts()
  for (const r of reasonRows) {
    if (r.reason in byReason) byReason[r.reason] = Number(r.n)
  }

  // Build a dense 7-day series (fill gaps with 0) so the chart is stable.
  const dayMap = new Map<string, number>()
  for (const r of byDayRows) {
    const key = new Date(r.d).toISOString().slice(0, 10)
    dayMap.set(key, Number(r.n))
  }
  const byDay: { date: string; count: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    byDay.push({ date: key, count: dayMap.get(key) ?? 0 })
  }

  return {
    totalLeads: Number(totalRows[0]?.total ?? 0),
    unanswered: Number(totalRows[0]?.unanswered ?? 0),
    newThisWeek: Number(weekRows[0]?.n ?? 0),
    byStatus,
    byReason,
    byDay,
  }
}

/** Record a chat → messenger transition (off-hours widget link tap). */
export async function recordMessengerClick(
  channelId: string | null,
  messenger: ClickMessenger,
): Promise<void> {
  await query(
    `INSERT INTO messenger_clicks (channel_id, messenger) VALUES ($1, $2)`,
    [channelId, messenger],
  )
}

export interface MessengerAnalytics {
  totalClicks: number
  telegramClicks: number
  whatsappClicks: number
  /** Clicks per day for the last 7 days, split by messenger (oldest first). */
  byDay: { date: string; telegram: number; whatsapp: number }[]
}

/**
 * Chat → messenger transition analytics. Scoped to a manager's channels when
 * managerId is supplied, otherwise system-wide (admin).
 */
export async function getMessengerAnalytics(
  managerId?: string,
): Promise<MessengerAnalytics> {
  const join = managerId
    ? 'JOIN channels ch ON ch.id = mc.channel_id AND ch.manager_id = $1'
    : ''
  const params = managerId ? [managerId] : []

  const [totals, byDayRows] = await Promise.all([
    query<{ messenger: ClickMessenger; n: string }>(
      `SELECT mc.messenger, count(*)::int AS n
         FROM messenger_clicks mc ${join}
        GROUP BY mc.messenger`,
      params,
    ),
    query<{ d: string | Date; messenger: ClickMessenger; n: string }>(
      `SELECT date_trunc('day', mc.created_at) AS d, mc.messenger,
              count(*)::int AS n
         FROM messenger_clicks mc ${join}
        WHERE mc.created_at >= now() - interval '6 days'
        GROUP BY 1, 2
        ORDER BY 1`,
      params,
    ),
  ])

  let telegramClicks = 0
  let whatsappClicks = 0
  for (const r of totals) {
    if (r.messenger === 'telegram') telegramClicks = Number(r.n)
    if (r.messenger === 'whatsapp') whatsappClicks = Number(r.n)
  }

  const dayMap = new Map<string, { telegram: number; whatsapp: number }>()
  for (const r of byDayRows) {
    const key = new Date(r.d).toISOString().slice(0, 10)
    const cur = dayMap.get(key) ?? { telegram: 0, whatsapp: 0 }
    cur[r.messenger] = Number(r.n)
    dayMap.set(key, cur)
  }
  const byDay: MessengerAnalytics['byDay'] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const v = dayMap.get(key) ?? { telegram: 0, whatsapp: 0 }
    byDay.push({ date: key, telegram: v.telegram, whatsapp: v.whatsapp })
  }

  return {
    totalClicks: telegramClicks + whatsappClicks,
    telegramClicks,
    whatsappClicks,
    byDay,
  }
}

/* --------------------------- Conversion goals --------------------------- */

export interface ConversionGoal {
  id: string
  name: string
  messenger: GoalMessenger
  active: boolean
  createdAt: string
}

interface ConversionGoalRow {
  id: string
  name: string
  messenger: GoalMessenger
  active: boolean
  created_at: string | Date
}

function toGoal(r: ConversionGoalRow): ConversionGoal {
  return {
    id: r.id,
    name: r.name,
    messenger: r.messenger,
    active: r.active,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

export async function listConversionGoals(): Promise<ConversionGoal[]> {
  const rows = await query<ConversionGoalRow>(
    `SELECT * FROM conversion_goals ORDER BY created_at ASC`,
  )
  return rows.map(toGoal)
}

export async function createConversionGoal(input: {
  name: string
  messenger: GoalMessenger
}): Promise<ConversionGoal> {
  const rows = await query<ConversionGoalRow>(
    `INSERT INTO conversion_goals (name, messenger) VALUES ($1, $2) RETURNING *`,
    [input.name.trim(), input.messenger],
  )
  return toGoal(rows[0])
}

export async function updateConversionGoal(
  id: string,
  input: { name?: string; messenger?: GoalMessenger; active?: boolean },
): Promise<void> {
  await query(
    `UPDATE conversion_goals
        SET name = COALESCE($2, name),
            messenger = COALESCE($3, messenger),
            active = COALESCE($4, active)
      WHERE id = $1`,
    [id, input.name?.trim() ?? null, input.messenger ?? null, input.active ?? null],
  )
}

export async function deleteConversionGoal(id: string): Promise<void> {
  await query(`DELETE FROM conversion_goals WHERE id = $1`, [id])
}

export interface GoalResult extends ConversionGoal {
  /** Number of messenger transitions matching this goal's filter. */
  completions: number
}

/**
 * Conversion goals with their completion counts (matching messenger clicks).
 * Scoped to a manager's channels when managerId is supplied.
 */
export async function getConversionGoalResults(
  managerId?: string,
): Promise<GoalResult[]> {
  const [goals, messenger] = await Promise.all([
    listConversionGoals(),
    getMessengerAnalytics(managerId),
  ])
  return goals.map((g) => {
    let completions = 0
    if (g.messenger === 'telegram') completions = messenger.telegramClicks
    else if (g.messenger === 'whatsapp') completions = messenger.whatsappClicks
    else completions = messenger.totalClicks
    return { ...g, completions }
  })
}

/* ----------------------- Admin dashboard rollups ----------------------- */

export interface ManagerPerformance {
  manager: Manager
  /** Total leads (conversations) owned by this manager. */
  totalLeads: number
  /** Leads whose first message arrived within the last 7 days. */
  newThisWeek: number
  /** Leads with at least one unanswered incoming message. */
  unanswered: number
  /** Effective-status breakdown. */
  byStatus: Record<LeadStatus, number>
  /** Chat → messenger transitions attributed to this manager's channels. */
  clicks: number
  /** Connected vs total channels. */
  connectedChannels: number
  totalChannels: number
  /** ISO timestamp of the most recent message in any of their conversations. */
  lastActivityAt: string | null
}

/**
 * Per-manager performance rollup powering the admin overview leaderboard. Every
 * manager is included (even with zero activity) so the admin sees full coverage.
 * A handful of grouped queries are stitched together in JS keyed by manager id —
 * cheap at this app's scale and far clearer than one giant join.
 */
export async function getManagerPerformance(): Promise<ManagerPerformance[]> {
  const managers = await listManagers()
  if (managers.length === 0) return []

  const [convRows, weekRows, clickRows, channelRows] = await Promise.all([
    query<{
      manager_id: string
      total: string
      unanswered: string
      eff_unsubscribed: string
      eff_liquid: string
      eff_not_liquid: string
      eff_transferred: string
      last_activity: string | Date | null
    }>(
      `SELECT manager_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE unread > 0)::int AS unanswered,
              count(*) FILTER (WHERE eff = 'unsubscribed')::int AS eff_unsubscribed,
              count(*) FILTER (WHERE eff = 'liquid')::int AS eff_liquid,
              count(*) FILTER (WHERE eff = 'not_liquid')::int AS eff_not_liquid,
              count(*) FILTER (WHERE eff = 'transferred')::int AS eff_transferred,
              max(last_message_at) AS last_activity
         FROM (
           SELECT manager_id, unread, last_message_at,
                  ${EFFECTIVE_STATUS_SQL} AS eff
             FROM conversations
         ) c
        GROUP BY manager_id`,
    ),
    query<{ manager_id: string; n: string }>(
      `SELECT manager_id, count(*)::int AS n FROM (
         SELECT c.id, c.manager_id, MIN(m.created_at) AS first_at
           FROM conversations c
           JOIN messages m ON m.conversation_id = c.id
          GROUP BY c.id, c.manager_id
       ) t
       WHERE first_at >= now() - interval '7 days'
       GROUP BY manager_id`,
    ),
    query<{ manager_id: string; n: string }>(
      `SELECT ch.manager_id, count(*)::int AS n
         FROM messenger_clicks mc
         JOIN channels ch ON ch.id = mc.channel_id
        WHERE ch.manager_id IS NOT NULL
        GROUP BY ch.manager_id`,
    ),
    query<{ manager_id: string; total: string; connected: string }>(
      `SELECT manager_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'connected')::int AS connected
         FROM channels
        WHERE manager_id IS NOT NULL
        GROUP BY manager_id`,
    ),
  ])

  const convById = new Map(convRows.map((r) => [r.manager_id, r]))
  const weekById = new Map(weekRows.map((r) => [r.manager_id, Number(r.n)]))
  const clicksById = new Map(clickRows.map((r) => [r.manager_id, Number(r.n)]))
  const channelsById = new Map(channelRows.map((r) => [r.manager_id, r]))

  return managers.map((manager) => {
    const c = convById.get(manager.id)
    const ch = channelsById.get(manager.id)
    const byStatus = emptyStatusCounts()
    if (c) {
      byStatus.unsubscribed = Number(c.eff_unsubscribed)
      byStatus.liquid = Number(c.eff_liquid)
      byStatus.not_liquid = Number(c.eff_not_liquid)
      byStatus.transferred = Number(c.eff_transferred)
    }
    return {
      manager,
      totalLeads: Number(c?.total ?? 0),
      newThisWeek: weekById.get(manager.id) ?? 0,
      unanswered: Number(c?.unanswered ?? 0),
      byStatus,
      clicks: clicksById.get(manager.id) ?? 0,
      connectedChannels: Number(ch?.connected ?? 0),
      totalChannels: Number(ch?.total ?? 0),
      lastActivityAt: c?.last_activity
        ? new Date(c.last_activity).toISOString()
        : null,
    }
  })
}

/**
 * Admin-only: fetch a single conversation by id WITHOUT manager scoping, along
 * with its owning manager's display name. Authorization is enforced by the
 * caller (server action guarded with requireAdmin).
 */
export async function getConversationAdmin(
  conversationId: string,
): Promise<(Conversation & { managerName: string | null }) | null> {
  const rows = await query<
    ConversationRow & { channel_name: string | null; manager_name: string | null }
  >(
    `SELECT c.*, ch.name AS channel_name, m.name AS manager_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN managers m ON m.id = c.manager_id
      WHERE c.id = $1
      LIMIT 1`,
    [conversationId],
  )
  if (!rows[0]) return null
  return {
    ...toConversation(rows[0]),
    channelName: rows[0].channel_name ?? undefined,
    managerName: rows[0].manager_name ?? null,
  }
}

/**
 * Admin-only: full message transcript for any conversation (no manager scope).
 * Authorization is enforced by the caller (requireAdmin).
 */
export async function listMessagesAdmin(
  conversationId: string,
): Promise<Message[]> {
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
       FROM messages m
       ${MESSAGE_REPLY_JOIN}
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC`,
    [conversationId],
  )
  return rows.map(toMessage)
}

/* --------------------------- Source groups ----------------------------- */
// A "source group" bundles the channels (Telegram / WhatsApp accounts + the
// live-chat widget) that belong to ONE website. It is configured once and used
// only for the admin overview report — it never touches inbox routing.

export interface SourceGroupChannel {
  id: string
  type: ChannelType
  name: string
  detail: string
  status: ChannelStatus
}

export interface SourceGroup {
  id: string
  name: string
  createdAt: string
  channels: SourceGroupChannel[]
}

/** All source groups with their member channels. */
export async function listSourceGroups(): Promise<SourceGroup[]> {
  const rows = await query<{
    id: string
    name: string
    created_at: string | Date
    channel_id: string | null
    channel_type: ChannelType | null
    channel_name: string | null
    channel_detail: string | null
    channel_status: ChannelStatus | null
  }>(
    `SELECT g.id, g.name, g.created_at,
            ch.id AS channel_id, ch.type AS channel_type, ch.name AS channel_name,
            ch.detail AS channel_detail, ch.status AS channel_status
       FROM source_groups g
       LEFT JOIN source_group_channels sgc ON sgc.group_id = g.id
       LEFT JOIN channels ch ON ch.id = sgc.channel_id
      ORDER BY g.created_at ASC, ch.type ASC, ch.name ASC`,
  )

  const map = new Map<string, SourceGroup>()
  for (const r of rows) {
    let g = map.get(r.id)
    if (!g) {
      g = {
        id: r.id,
        name: r.name,
        createdAt: new Date(r.created_at).toISOString(),
        channels: [],
      }
      map.set(r.id, g)
    }
    if (r.channel_id && r.channel_type) {
      g.channels.push({
        id: r.channel_id,
        type: r.channel_type,
        name: r.channel_name ?? 'Канал',
        detail: r.channel_detail ?? '',
        status: r.channel_status ?? 'pending',
      })
    }
  }
  return [...map.values()]
}

/** Replace a group's channel membership with the given channel ids. */
async function setGroupChannels(
  groupId: string,
  channelIds: string[],
): Promise<void> {
  await query(`DELETE FROM source_group_channels WHERE group_id = $1`, [groupId])
  const ids = [...new Set(channelIds)].filter(Boolean)
  for (const channelId of ids) {
    // A channel belongs to at most one group; steal it from any other group so
    // the latest assignment wins instead of erroring on the UNIQUE constraint.
    await query(
      `INSERT INTO source_group_channels (group_id, channel_id)
       VALUES ($1, $2)
       ON CONFLICT (channel_id) DO UPDATE SET group_id = EXCLUDED.group_id`,
      [groupId, channelId],
    )
  }
}

export async function createSourceGroup(
  name: string,
  channelIds: string[],
): Promise<SourceGroup> {
  const rows = await query<{ id: string }>(
    `INSERT INTO source_groups (name) VALUES ($1) RETURNING id`,
    [name.trim() || 'Источник'],
  )
  const id = rows[0].id
  await setGroupChannels(id, channelIds)
  const all = await listSourceGroups()
  return all.find((g) => g.id === id) as SourceGroup
}

export async function updateSourceGroup(
  id: string,
  input: { name?: string; channelIds?: string[] },
): Promise<void> {
  if (typeof input.name === 'string') {
    await query(`UPDATE source_groups SET name = $2 WHERE id = $1`, [
      id,
      input.name.trim() || 'Источник',
    ])
  }
  if (input.channelIds) {
    await setGroupChannels(id, input.channelIds)
  }
}

export async function deleteSourceGroup(id: string): Promise<void> {
  await query(`DELETE FROM source_groups WHERE id = $1`, [id])
}

/* ----------------------- Source group analytics ------------------------ */

export interface GroupChannelStat {
  channelId: string
  name: string
  type: ChannelType
  /** Distinct people (conversations) who wrote in within the range. */
  people: number
  /** Inbound messages received within the range. */
  messages: number
}

export interface GroupAnalytics {
  groupId: string
  groupName: string
  from: string
  to: string
  /** Distinct people (conversations) who wrote in across the whole group. */
  totalPeople: number
  totalMessages: number
  byType: Record<ChannelType, { people: number; messages: number }>
  byChannel: GroupChannelStat[]
  /** People per day, split by messenger type (oldest first, dense). */
  byDay: {
    date: string
    telegram: number
    whatsapp: number
    livechat: number
    max: number
    vk: number
  }[]
  /**
   * People per hour (0–23) for a single-day range, split by messenger type.
   * Only populated when the range covers exactly one local day (e.g. "today")
   * — used to draw the intraday running line. Null for multi-day ranges.
   */
  byHour:
    | {
      hour: number
      telegram: number
      whatsapp: number
      livechat: number
      max: number
      vk: number
    }[]
    | null
}

function emptyTypeStats(): Record<ChannelType, { people: number; messages: number }> {
  return {
    telegram: { people: 0, messages: 0 },
    whatsapp: { people: 0, messages: 0 },
    livechat: { people: 0, messages: 0 },
    max: { people: 0, messages: 0 },
    vk: { people: 0, messages: 0 },
  }
}

/**
 * Detailed "who wrote in" report for one source group over a date range.
 * A "person" is a distinct conversation (one contact on one channel) that has
 * at least one inbound message inside [from, to). Counts are broken down per
 * channel, per messenger type, and per day.
 */
export async function getGroupAnalytics(
  groupId: string,
  fromISO: string,
  toISO: string,
  // Client timezone offset, in the JS `Date.getTimezoneOffset()` convention
  // (minutes; MSK = -180). Day buckets are computed in the visitor admin's
  // local calendar so "today" lines up with their clock, not the server's UTC.
  tzOffsetMinutes = 0,
): Promise<GroupAnalytics> {
  const groupRows = await query<{ name: string }>(
    `SELECT name FROM source_groups WHERE id = $1`,
    [groupId],
  )
  const groupName = groupRows[0]?.name ?? 'Источник'
  const off = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0
  const params = [groupId, fromISO, toISO]
  const dayParams = [...params, off]
  // local wall-clock = UTC wall-clock - offsetMinutes (MSK: -(-180) = +180).
  const localDayExpr = `to_char((m.created_at AT TIME ZONE 'UTC') - make_interval(mins => $4::int), 'YYYY-MM-DD')`

  const [totalRows, channelRows, dayRows] = await Promise.all([
    query<{ people: string; messages: string }>(
      `SELECT count(DISTINCT c.id)::int AS people, count(m.id)::int AS messages
         FROM source_group_channels sgc
         JOIN conversations c ON c.channel_id = sgc.channel_id
         JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.group_id = $1`,
      params,
    ),
    query<{
      channel_id: string
      name: string
      type: ChannelType
      people: string
      messages: string
    }>(
      `SELECT ch.id AS channel_id, ch.name, ch.type,
              count(DISTINCT c.id) FILTER (WHERE m.id IS NOT NULL)::int AS people,
              count(m.id)::int AS messages
         FROM source_group_channels sgc
         JOIN channels ch ON ch.id = sgc.channel_id
         LEFT JOIN conversations c ON c.channel_id = ch.id
         LEFT JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.group_id = $1
        GROUP BY ch.id, ch.name, ch.type
        ORDER BY people DESC, ch.name ASC`,
      params,
    ),
    query<{ d: string; type: ChannelType; people: string }>(
      `SELECT ${localDayExpr} AS d, ch.type,
              count(DISTINCT c.id)::int AS people
         FROM source_group_channels sgc
         JOIN channels ch ON ch.id = sgc.channel_id
         JOIN conversations c ON c.channel_id = ch.id
         JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.group_id = $1
        GROUP BY 1, 2
        ORDER BY 1`,
      dayParams,
    ),
  ])

  const byChannel: GroupChannelStat[] = channelRows.map((r) => ({
    channelId: r.channel_id,
    name: r.name,
    type: r.type,
    people: Number(r.people),
    messages: Number(r.messages),
  }))

  const byType = emptyTypeStats()
  for (const c of byChannel) {
    byType[c.type].people += c.people
    byType[c.type].messages += c.messages
  }

  // Dense per-day series across [from, to) so the chart has no gaps. `r.d` is
  // already a local 'YYYY-MM-DD' string (bucketed in the admin's timezone).
  const dayMap = new Map<string, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
  for (const r of dayRows) {
    const cur = dayMap.get(r.d) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
    cur[r.type] = Number(r.people)
    dayMap.set(r.d, cur)
  }
  // Build the axis in the same local calendar. We shift the UTC instants by the
  // offset and then iterate whole UTC days, so each key is the local day string.
  const byDay: GroupAnalytics['byDay'] = []
  const startShift = new Date(new Date(fromISO).getTime() - off * 60000)
  const endShift = new Date(new Date(toISO).getTime() - off * 60000)
  let cursor = new Date(
    Date.UTC(
      startShift.getUTCFullYear(),
      startShift.getUTCMonth(),
      startShift.getUTCDate(),
    ),
  )
  // Cap the series at 92 days to keep the response bounded for huge ranges.
  for (let i = 0; i < 92 && cursor < endShift; i++) {
    const key = cursor.toISOString().slice(0, 10)
    const v = dayMap.get(key) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
    byDay.push({ date: key, ...v })
    cursor = new Date(cursor)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  // For a single local day, also bucket people by hour so the UI can draw an
  // intraday running line (e.g. the "today" view).
  let byHour: GroupAnalytics['byHour'] = null
  if (byDay.length === 1) {
    // local hour = (utc - offset) hour-of-day.
    const localHourExpr = `EXTRACT(HOUR FROM (m.created_at AT TIME ZONE 'UTC') - make_interval(mins => $4::int))::int`
    const hourRows = await query<{ h: number; type: ChannelType; people: string }>(
      `SELECT ${localHourExpr} AS h, ch.type,
              count(DISTINCT c.id)::int AS people
         FROM source_group_channels sgc
         JOIN channels ch ON ch.id = sgc.channel_id
         JOIN conversations c ON c.channel_id = ch.id
         JOIN messages m ON m.conversation_id = c.id
              AND m.direction = 'in'
              AND m.created_at >= $2 AND m.created_at < $3
        WHERE sgc.group_id = $1
        GROUP BY 1, 2`,
      dayParams,
    )
    const hourMap = new Map<number, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
    for (const r of hourRows) {
      const cur = hourMap.get(r.h) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
      cur[r.type] = Number(r.people)
      hourMap.set(r.h, cur)
    }
    byHour = []
    for (let h = 0; h < 24; h++) {
      const v = hourMap.get(h) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
      byHour.push({ hour: h, ...v })
    }
  }

  return {
    groupId,
    groupName,
    from: fromISO,
    to: toISO,
    totalPeople: Number(totalRows[0]?.people ?? 0),
    totalMessages: Number(totalRows[0]?.messages ?? 0),
    byType,
    byChannel,
    byDay,
    byHour,
  }
}

export interface ManagerActivityAnalytics {
  from: string
  to: string
  totalPeople: number
  /** People per day, split by messenger type (oldest first, dense). */
  byDay: {
    date: string
    telegram: number
    whatsapp: number
    livechat: number
    max: number
    vk: number
  }[]
  /** People per hour for a single-day range, or null for multi-day ranges. */
  byHour:
    | {
      hour: number
      telegram: number
      whatsapp: number
      livechat: number
      max: number
      vk: number
    }[]
    | null
}

/**
 * Activity analytics for a single manager — distinct people who wrote in,
 * bucketed by day (and by hour for a single-day range), split by messenger
 * type. Mirrors getGroupAnalytics but scoped to the manager's own
 * conversations. Day/hour buckets use the manager's local calendar via
 * `tzOffsetMinutes` (JS `Date.getTimezoneOffset()` convention; MSK = -180).
 */
export async function getManagerActivityAnalytics(
  managerId: string,
  fromISO: string,
  toISO: string,
  tzOffsetMinutes = 0,
): Promise<ManagerActivityAnalytics> {
  const off = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0
  const params = [managerId, fromISO, toISO]
  const dayParams = [...params, off]
  // Bucket by each lead's FIRST inbound message ("first contact"), so every lead
  // is counted exactly once — on the day they first wrote in — matching the
  // dashboard KPIs. A lead writing again on a later day is never re-counted.
  const localDayExpr = `to_char((f.first_at AT TIME ZONE 'UTC') - make_interval(mins => $4::int), 'YYYY-MM-DD')`
  const FIRST_CONTACT_CTE = `
    SELECT c.id, c.channel_id,
           MIN(m.created_at) FILTER (WHERE m.direction = 'in') AS first_at
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
     WHERE c.manager_id = $1
     GROUP BY c.id, c.channel_id`

  const [totalRows, dayRows] = await Promise.all([
    query<{ people: string }>(
      `SELECT count(*)::int AS people
         FROM (${FIRST_CONTACT_CTE}) f
        WHERE f.first_at >= $2 AND f.first_at < $3`,
      params,
    ),
    query<{ d: string; type: ChannelType; people: string }>(
      `SELECT ${localDayExpr} AS d, ch.type,
              count(*)::int AS people
         FROM (${FIRST_CONTACT_CTE}) f
         JOIN channels ch ON ch.id = f.channel_id
        WHERE f.first_at >= $2 AND f.first_at < $3
        GROUP BY 1, 2
        ORDER BY 1`,
      dayParams,
    ),
  ])

  const dayMap = new Map<string, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
  for (const r of dayRows) {
    const cur = dayMap.get(r.d) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
    cur[r.type] = Number(r.people)
    dayMap.set(r.d, cur)
  }

  const byDay: ManagerActivityAnalytics['byDay'] = []
  const startShift = new Date(new Date(fromISO).getTime() - off * 60000)
  const endShift = new Date(new Date(toISO).getTime() - off * 60000)
  let cursor = new Date(
    Date.UTC(
      startShift.getUTCFullYear(),
      startShift.getUTCMonth(),
      startShift.getUTCDate(),
    ),
  )
  for (let i = 0; i < 92 && cursor < endShift; i++) {
    const key = cursor.toISOString().slice(0, 10)
    const v = dayMap.get(key) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
    byDay.push({ date: key, ...v })
    cursor = new Date(cursor)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  let byHour: ManagerActivityAnalytics['byHour'] = null
  if (byDay.length === 1) {
    const localHourExpr = `EXTRACT(HOUR FROM (f.first_at AT TIME ZONE 'UTC') - make_interval(mins => $4::int))::int`
    const hourRows = await query<{ h: number; type: ChannelType; people: string }>(
      `SELECT ${localHourExpr} AS h, ch.type,
              count(*)::int AS people
         FROM (${FIRST_CONTACT_CTE}) f
         JOIN channels ch ON ch.id = f.channel_id
        WHERE f.first_at >= $2 AND f.first_at < $3
        GROUP BY 1, 2`,
      dayParams,
    )
    const hourMap = new Map<number, { telegram: number; whatsapp: number; livechat: number; max: number; vk: number }>()
    for (const r of hourRows) {
      const cur = hourMap.get(r.h) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
      cur[r.type] = Number(r.people)
      hourMap.set(r.h, cur)
    }
    byHour = []
    for (let h = 0; h < 24; h++) {
      const v = hourMap.get(h) ?? { telegram: 0, whatsapp: 0, livechat: 0, max: 0, vk: 0 }
      byHour.push({ hour: h, ...v })
    }
  }

  return {
    from: fromISO,
    to: toISO,
    totalPeople: Number(totalRows[0]?.people ?? 0),
    byDay,
    byHour,
  }
}

/* -------------------------------------------------------------------------- */
/*  Quick replies (manager-scoped canned responses)                           */
/* -------------------------------------------------------------------------- */

interface QuickReplyRow {
  id: string
  title: string
  body: string
  sort_order: number
  created_at: string | Date
}

function toQuickReply(r: QuickReplyRow): QuickReply {
  return {
    id: r.id,
    title: r.title ?? '',
    body: r.body,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  }
}

/** All quick replies owned by a manager, in their chosen order. */
export async function listQuickReplies(
  managerId: string,
): Promise<QuickReply[]> {
  const rows = await query<QuickReplyRow>(
    `SELECT id, title, body, sort_order, created_at
       FROM quick_replies
      WHERE manager_id = $1
      ORDER BY sort_order ASC, created_at ASC`,
    [managerId],
  )
  return rows.map(toQuickReply)
}

/** Create a quick reply for a manager. Appends to the end of their list. */
export async function createQuickReply(
  managerId: string,
  title: string,
  body: string,
): Promise<QuickReply | null> {
  const rows = await query<QuickReplyRow>(
    `INSERT INTO quick_replies (manager_id, title, body, sort_order)
     VALUES (
       $1, $2, $3,
       COALESCE((SELECT MAX(sort_order) + 1 FROM quick_replies WHERE manager_id = $1), 0)
     )
     RETURNING id, title, body, sort_order, created_at`,
    [managerId, title, body],
  )
  return rows[0] ? toQuickReply(rows[0]) : null
}

/** Update a quick reply's title/body. Scoped to the owning manager. */
export async function updateQuickReply(
  id: string,
  managerId: string,
  title: string,
  body: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE quick_replies
        SET title = $3, body = $4, updated_at = now()
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [id, managerId, title, body],
  )
  return rows.length > 0
}

/** Delete a quick reply. Scoped to the owning manager. */
export async function deleteQuickReply(
  id: string,
  managerId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM quick_replies
      WHERE id = $1 AND manager_id = $2
      RETURNING id`,
    [id, managerId],
  )
  return rows.length > 0
}

/**
 * Persist a manager's preferred ordering. `orderedIds` is the full list of the
 * manager's quick-reply ids in the desired order; only rows owned by the
 * manager are touched.
 */
export async function reorderQuickReplies(
  managerId: string,
  orderedIds: string[],
): Promise<void> {
  if (orderedIds.length === 0) return
  // One UPDATE keyed by array position keeps this atomic and avoids N queries.
  await query(
    `UPDATE quick_replies AS q
        SET sort_order = pos.idx, updated_at = now()
       FROM unnest($2::uuid[]) WITH ORDINALITY AS pos(id, idx)
      WHERE q.id = pos.id AND q.manager_id = $1`,
    [managerId, orderedIds],
  )
}

/* =========================== Yandex Telemost ============================ */

/**
 * App-level Telemost config, stored under app_settings key `telemost` and
 * managed by the admin (not via env vars). The OAuth token is encrypted at rest;
 * everything else is non-secret. `enabled` lets the admin turn the feature off
 * without deleting the token.
 */
export interface TelemostConfig {
  /** Decrypted OAuth token for cloud-api.yandex.net (telemost-api scope). */
  token: string
  /** Default waiting-room level applied to new meetings. */
  waitingRoomLevel: 'PUBLIC' | 'ORGANIZATION' | 'ADMINISTRATOR'
  /** When false, the feature is hidden even if a token exists. */
  enabled: boolean
}

const TELEMOST_KEY = 'telemost'

interface TelemostConfigRow {
  token?: string
  waitingRoomLevel?: TelemostConfig['waitingRoomLevel']
  enabled?: boolean
}

async function readTelemostRow(): Promise<TelemostConfigRow | null> {
  const rows = await query<{ value: TelemostConfigRow }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [TELEMOST_KEY],
  )
  return rows[0]?.value ?? null
}

/** Read + decrypt the full Telemost config. Null when no token is saved. */
export async function getTelemostConfig(): Promise<TelemostConfig | null> {
  const v = await readTelemostRow()
  if (!v?.token) return null
  try {
    return {
      token: decrypt(v.token),
      waitingRoomLevel: v.waitingRoomLevel ?? 'PUBLIC',
      enabled: v.enabled ?? true,
    }
  } catch (err) {
    console.error('[v0] getTelemostConfig: decrypt failed:', err)
    return null
  }
}

/** Non-secret view of the config for admin display. */
export interface TelemostStatus {
  /** A token is saved. */
  configured: boolean
  /** Token saved AND the feature is enabled — the button appears for managers. */
  enabled: boolean
  waitingRoomLevel: TelemostConfig['waitingRoomLevel']
  tokenMask: string | null
}

export async function getTelemostStatus(): Promise<TelemostStatus> {
  const v = await readTelemostRow()
  let tokenMask: string | null = null
  if (v?.token) {
    try {
      tokenMask = maskSecret(decrypt(v.token))
    } catch {
      tokenMask = null
    }
  }
  return {
    configured: Boolean(v?.token),
    enabled: Boolean(v?.token) && (v?.enabled ?? true),
    waitingRoomLevel: v?.waitingRoomLevel ?? 'PUBLIC',
    tokenMask,
  }
}

/**
 * Admin: save Telemost settings. A blank token keeps the existing one (so the
 * admin can toggle enabled / change the waiting-room level without re-entering
 * the secret). Passing `clearToken` removes it entirely.
 */
export async function saveTelemostConfig(input: {
  token?: string
  waitingRoomLevel: TelemostConfig['waitingRoomLevel']
  enabled: boolean
  clearToken?: boolean
}): Promise<void> {
  const existing = await readTelemostRow()
  let token = existing?.token
  if (input.clearToken) {
    token = undefined
  } else if (input.token && input.token.trim()) {
    token = encrypt(input.token.trim())
  }
  const value: TelemostConfigRow = {
    token,
    waitingRoomLevel: input.waitingRoomLevel,
    enabled: input.enabled,
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [TELEMOST_KEY, JSON.stringify(value)],
  )
}

/** A meeting row for the manager's Видеовстречи tab. */
export interface TelemostMeetingRecord {
  id: string
  conversationId: string | null
  contactName: string | null
  joinUrl: string
  delivered: boolean
  createdAt: string
}

/** Record a created meeting (best-effort history). */
export async function recordTelemostMeeting(input: {
  managerId: string
  conversationId?: string | null
  conferenceId?: string
  joinUrl: string
  delivered: boolean
}): Promise<void> {
  try {
    await query(
      `INSERT INTO telemost_meetings
         (manager_id, conversation_id, conference_id, join_url, delivered)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.managerId,
        input.conversationId ?? null,
        input.conferenceId ?? '',
        input.joinUrl,
        input.delivered,
      ],
    )
  } catch (err) {
    // History table missing (pre-042) — never fail the actual meeting creation.
    console.error('[v0] recordTelemostMeeting skipped:', err)
  }
}

/** Recent meetings created by a manager (most recent first). */
export async function listTelemostMeetings(
  managerId: string,
  limit = 30,
): Promise<TelemostMeetingRecord[]> {
  try {
    const rows = await query<{
      id: string
      conversation_id: string | null
      contact_name: string | null
      join_url: string
      delivered: boolean
      created_at: string
    }>(
      `SELECT m.id, m.conversation_id, c.contact_name, m.join_url,
              m.delivered, m.created_at
         FROM telemost_meetings m
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE m.manager_id = $1
        ORDER BY m.created_at DESC
        LIMIT $2`,
      [managerId, limit],
    )
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      contactName: r.contact_name,
      joinUrl: r.join_url,
      delivered: r.delivered,
      createdAt: r.created_at,
    }))
  } catch (err) {
    console.error('[v0] listTelemostMeetings failed:', err)
    return []
  }
}
