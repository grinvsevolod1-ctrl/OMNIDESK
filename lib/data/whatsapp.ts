/**
 * WhatsApp Cloud API channel: config vault, send/receive, media, status.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { randomUUID, randomBytes } from 'crypto'
import { query } from '../db'
import { decrypt, encrypt, maskSecret } from '../crypto'
import type { ProxyDescriptor } from '../proxy-agent'
import type { ChannelStatus, MediaType } from '../types'
import { readPool, type ChannelRow } from './shared'
// Cross-domain calls resolved at runtime via the facade to avoid import cycles.
import {
  getProxyForChannel,
  recordWebhookInbound,
  resolveLivechatAgentId,
} from '../data'

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
