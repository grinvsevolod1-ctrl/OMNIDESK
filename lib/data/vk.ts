/**
 * VK Callback API channel: config vault, inbound ingest, outbound send, media.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { query } from '../db'
import { decrypt } from '../crypto'
import type { ProxyDescriptor } from '../proxy-agent'
import type { ChannelStatus, MediaType } from '../types'
import { readPool, type ChannelRow } from './shared'
// Cross-domain calls resolved at runtime via the facade to avoid import cycles.
import {
  getProxyForChannel,
  recordWebhookInbound,
  resolveLivechatAgentId,
} from '../data'

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
