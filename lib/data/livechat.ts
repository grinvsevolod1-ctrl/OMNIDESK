/**
 * Live chat widget channel: API-key lookup, widget config, working hours,
 * agent routing, inbound ingest, pending leads and visitor message history.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { query } from '../db'
import type { ChannelStatus, ConversationMeta, Message } from '../types'
import {
  resolveWidgetConfig,
  type LivechatWidgetConfig,
  type WidgetWorkingHours,
} from '../widget-config'
import {
  assignManagerRoundRobin,
  readPool,
  sanitizeConversationMeta,
  type ChannelRow,
} from './shared'
// Cross-domain calls resolved at runtime via the facade to avoid import cycles.
// getLivechatGlobalDefaults / mergeLegacyAppearance / LivechatWidgetAppearance
// live in the widget-defaults section that is still part of lib/data.
import {
  applyLunchSubstitution,
  getLivechatGlobalDefaults,
  mergeLegacyAppearance,
  type LivechatWidgetAppearance,
} from '../data'

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
      console.error('recordLivechatInbound: visitor seq unavailable:', err)
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
    console.error('recordLivechatPendingLead failed (migration 037?):', err)
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


/* recordWebhookInbound — extracted to ./data/inbound */
