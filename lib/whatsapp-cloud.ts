/**
 * WhatsApp Cloud API client (Meta Graph API).
 *
 * This replaces the old Baileys (unofficial WhatsApp Web) transport. Unlike
 * Baileys it needs no persistent socket and no worker session: inbound arrives
 * via the app-level webhook (see app/api/whatsapp/webhook) and outbound is a plain
 * REST call — exactly the same model as the MAX bot integration, which is why
 * it is rock-solid compared to the socket-based approach.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const GRAPH_VERSION = 'v22.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

export type CloudResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

async function graph<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<CloudResult<T>> {
  let res: Response
  try {
    res = await fetch(`${GRAPH_BASE}/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    })
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'network error',
    }
  }

  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // non-JSON body
  }

  if (!res.ok) {
    const apiErr = (json as { error?: { message?: string } } | null)?.error
    return {
      ok: false,
      status: res.status,
      error: apiErr?.message || text || `HTTP ${res.status}`,
    }
  }
  return { ok: true, data: (json ?? {}) as T }
}

export interface PhoneNumberInfo {
  id: string
  display_phone_number?: string
  verified_name?: string
  quality_rating?: string
}

/**
 * Validate credentials by reading the phone number node. A 200 means the token
 * is valid and has access to this phone number id.
 */
export function getPhoneNumber(
  phoneNumberId: string,
  token: string,
): Promise<CloudResult<PhoneNumberInfo>> {
  return graph<PhoneNumberInfo>(
    `${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name,quality_rating`,
    token,
  )
}

export interface WabaPhoneNumber {
  id: string
  display_phone_number?: string
  verified_name?: string
  quality_rating?: string
}

/**
 * List all phone numbers registered under a WhatsApp Business Account. Used by
 * the admin to auto-import numbers instead of typing each phone number id by
 * hand. Requires the access token to have whatsapp_business_management scope.
 */
export function listWabaPhoneNumbers(
  wabaId: string,
  token: string,
): Promise<CloudResult<{ data: WabaPhoneNumber[] }>> {
  return graph<{ data: WabaPhoneNumber[] }>(
    `${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
    token,
  )
}

export interface SendResult {
  messages?: { id: string }[]
  contacts?: { wa_id: string }[]
}

/**
 * Send a plain text message. Only valid inside the 24h customer-service window;
 * outside it Meta rejects free-form text and requires an approved template
 * (not supported yet — see the integration notes).
 */
export function sendText(
  phoneNumberId: string,
  token: string,
  to: string,
  body: string,
): Promise<CloudResult<SendResult>> {
  return graph<SendResult>(
    `${encodeURIComponent(phoneNumberId)}/messages`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body },
      }),
    },
  )
}

/**
 * Send a read receipt for an inbound message so the contact sees the blue
 * ticks. Best-effort; failures are non-fatal.
 */
export function markRead(
  phoneNumberId: string,
  token: string,
  messageId: string,
): Promise<CloudResult<unknown>> {
  return graph(`${encodeURIComponent(phoneNumberId)}/messages`, token, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  })
}

/* --------------------------------- Media --------------------------------- */

/** Outbound media kinds the Cloud API accepts as a typed message. */
export type WaMediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'

export interface MediaUrlInfo {
  url: string
  mime_type?: string
  file_size?: number
  id: string
}

/**
 * Resolve the short-lived, authenticated download URL for a media id. Meta keeps
 * media for ~30 days; the returned `url` must be fetched WITH the bearer token
 * (see downloadMedia) — it is not publicly accessible.
 */
export function getMediaUrl(
  mediaId: string,
  token: string,
): Promise<CloudResult<MediaUrlInfo>> {
  return graph<MediaUrlInfo>(encodeURIComponent(mediaId), token)
}

/**
 * Fetch the raw media bytes from the (already resolved) Graph download URL. The
 * URL requires the bearer token. Returns the live Response so callers can stream
 * it straight through to the browser without buffering. Null on network error.
 */
export async function downloadMedia(
  url: string,
  token: string,
): Promise<Response | null> {
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
  } catch (err) {
    console.error('[v0] downloadMedia: fetch failed:', err)
    return null
  }
}

/**
 * Upload media bytes to a phone number and return the resulting media id, which
 * can then be sent via sendMedia. Uses multipart/form-data (NOT the JSON graph
 * helper). Required scope: whatsapp_business_messaging.
 */
export async function uploadMedia(
  phoneNumberId: string,
  token: string,
  bytes: Blob,
  mime: string,
  filename = 'file',
): Promise<CloudResult<{ id: string }>> {
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', mime)
  form.append('file', bytes, filename)

  let res: Response
  try {
    res = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}/media`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        cache: 'no-store',
      },
    )
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'network error',
    }
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // non-JSON
  }
  if (!res.ok) {
    const apiErr = (json as { error?: { message?: string } } | null)?.error
    return {
      ok: false,
      status: res.status,
      error: apiErr?.message || text || `HTTP ${res.status}`,
    }
  }
  return { ok: true, data: (json ?? {}) as { id: string } }
}

/**
 * Send a media message referencing an uploaded media id. Only `image`, `video`
 * and `document` accept a caption; `audio`/`sticker` ignore it. Valid only
 * inside the 24h customer-service window (same constraint as sendText).
 */
export function sendMedia(
  phoneNumberId: string,
  token: string,
  to: string,
  kind: WaMediaKind,
  mediaId: string,
  caption?: string,
  filename?: string,
): Promise<CloudResult<SendResult>> {
  const media: Record<string, unknown> = { id: mediaId }
  if (caption && (kind === 'image' || kind === 'video' || kind === 'document')) {
    media.caption = caption
  }
  if (filename && kind === 'document') media.filename = filename
  return graph<SendResult>(
    `${encodeURIComponent(phoneNumberId)}/messages`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: kind,
        [kind]: media,
      }),
    },
  )
}
