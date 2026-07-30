/**
 * MAX bot channel: config vault, agent routing, inbound wrapper, dispatch.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { query } from '../db'
import { decrypt } from '../crypto'
import type { ProxyDescriptor } from '../proxy-agent'
import type { ChannelStatus } from '../types'
import { readPool, type ChannelRow } from './shared'
// Cross-domain calls resolved at runtime via the facade to avoid import cycles.
import {
  getProxyForChannel,
  recordWebhookInbound,
  resolveLivechatAgentId,
} from '../data'

/* ------------------------------- MAX -------------------------------- */

/**
 * A connected MAX bot channel, with its secrets decrypted for server-side use.
 * The bot token and webhook secret are stored encrypted in `config`.
 */
export interface MaxChannel {
  id: string
  managerId: string | null
  /** Decrypted MAX bot token (Authorization header for platform-api2.max.ru). */
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
    console.error('toMaxChannel: failed to decrypt secrets:', err)
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
