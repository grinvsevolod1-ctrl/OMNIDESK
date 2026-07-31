/**
 * Channels: CRUD, status/session, live-chat admin widget config, global widget
 * defaults, appearance and admin channel management.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
import type {
  Channel,
  ChannelStatus,
  ChannelType,
  SessionStatus,
} from '../types'
import {
  resolveGlobalDefaults,
  resolveWidgetConfig,
  type LivechatGlobalDefaults,
  type LivechatWidgetConfig,
} from '../widget-config'
import {
  channelColumns,
  readPool,
  toChannel,
  type ChannelRow,
} from './shared'
// Cross-domain read resolved at runtime via the facade to avoid an import cycle.
import { listManagers } from '../data'

/* ----------------------------- Channels ----------------------------- */

export async function listChannels(managerId: string): Promise<Channel[]> {
  const rows = await query<ChannelRow>(
    `SELECT ${channelColumns()} FROM channels WHERE manager_id = $1 ORDER BY created_at DESC`,
    [managerId],
  )
  return rows.map(toChannel)
}

export async function listAllChannels(): Promise<Channel[]> {
  const rows = await query<ChannelRow>(
    `SELECT ${channelColumns()} FROM channels ORDER BY created_at DESC`,
  )
  return rows.map(toChannel)
}

export async function createChannel(input: {
  managerId: string | null
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
    `SELECT ${channelColumns()} FROM channels WHERE id = $1 AND manager_id = $2 LIMIT 1`,
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
      `SELECT ${channelColumns('c')}, m.name AS manager_name
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
export function mergeLegacyAppearance(
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
    `SELECT ${channelColumns('c')}, m.name AS manager_name, p.label AS proxy_label
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
    `SELECT ${channelColumns()} FROM channels WHERE id = $1 LIMIT 1`,
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

