import { createHmac, timingSafeEqual } from 'crypto'
import {
  getWhatsappWebhookSecrets,
  recordWhatsappInbound,
  resolveWhatsappAgentId,
  resolveWhatsappInboundByPhoneId,
  updateWhatsappMessageStatus,
} from '@/lib/data'
import type { MediaType } from '@/lib/types'
import { runLivechatAutopilot } from '@/lib/autopilot/runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * App-level Meta webhook GET handshake.
 *
 * With the Cloud API a single Meta app has ONE webhook shared by every phone
 * number under the WhatsApp Business Account. The admin provisions a verify
 * token under /admin/whatsapp (this is decoupled from the access token, so the
 * webhook can be registered in Meta before a working token exists). This
 * endpoint echoes hub.challenge only when the verify token matches.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  const { verifyToken } = await getWhatsappWebhookSecrets()
  if (!verifyToken) return new Response('not_configured', { status: 503 })

  if (mode === 'subscribe' && token && token === verifyToken) {
    return new Response(challenge ?? '', { status: 200 })
  }
  return new Response('forbidden', { status: 403 })
}

/* ------------------------------ Inbound ------------------------------ */

interface WaContact {
  profile?: { name?: string }
  wa_id?: string
}
/** A media object as Meta sends it (image/video/audio/document/sticker). */
interface WaMediaObject {
  id?: string
  mime_type?: string
  caption?: string
  filename?: string
  voice?: boolean
  sha256?: string
}
interface WaMessage {
  from?: string
  id?: string
  type?: string
  text?: { body?: string }
  image?: WaMediaObject
  video?: WaMediaObject
  audio?: WaMediaObject
  document?: WaMediaObject
  sticker?: WaMediaObject
  location?: { latitude?: number; longitude?: number; name?: string; address?: string }
  /** Quoted message this one replies to. */
  context?: { from?: string; id?: string }
}
/** A delivery-status event (sent/delivered/read/failed) for an outbound msg. */
interface WaStatus {
  id?: string
  status?: string
  recipient_id?: string
}
interface WaValue {
  metadata?: { phone_number_id?: string }
  contacts?: WaContact[]
  messages?: WaMessage[]
  statuses?: WaStatus[]
}
interface WaWebhookBody {
  object?: string
  entry?: { changes?: { value?: WaValue; field?: string }[] }[]
}

/** What we extract from a single inbound message before persisting it. */
interface ParsedInbound {
  body: string
  preview: string
  mediaType: MediaType | null
  mediaMime: string | null
  mediaName: string | null
  mediaRef: Record<string, unknown> | null
}

/** Conversation-list label for a media message that has no caption. */
const MEDIA_PREVIEW: Record<MediaType, string> = {
  image: '[Фото]',
  video: '[Видео]',
  video_note: '[Видеосообщение]',
  audio: '[Аудио]',
  voice: '[Голосовое сообщение]',
  sticker: '[Стикер]',
  document: '[Документ]',
}

/**
 * Normalise a Cloud API inbound message into our storage shape. Returns null for
 * message kinds we don't persist (e.g. system/unsupported). Media bytes are NOT
 * downloaded here — we keep the WhatsApp media id in `mediaRef` and the proxy
 * fetches them on demand.
 */
function parseInbound(m: WaMessage): ParsedInbound | null {
  const mediaFor = (
    kind: MediaType,
    obj: WaMediaObject | undefined,
  ): ParsedInbound | null => {
    if (!obj?.id) return null
    const caption = (obj.caption ?? '').trim()
    return {
      body: caption,
      preview: caption || MEDIA_PREVIEW[kind],
      mediaType: kind,
      mediaMime: obj.mime_type ?? null,
      mediaName: obj.filename ?? null,
      mediaRef: { waMediaId: obj.id },
    }
  }

  switch (m.type) {
    case 'text': {
      const body = (m.text?.body ?? '').trim()
      if (!body) return null
      return { body, preview: body, mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
    }
    case 'image':
      return mediaFor('image', m.image)
    case 'video':
      return mediaFor('video', m.video)
    case 'sticker':
      return mediaFor('sticker', m.sticker)
    case 'document':
      return mediaFor('document', m.document)
    case 'audio':
      // Voice notes arrive as type 'audio' with voice:true.
      return mediaFor(m.audio?.voice ? 'voice' : 'audio', m.audio)
    case 'location': {
      const loc = m.location
      if (typeof loc?.latitude !== 'number' || typeof loc?.longitude !== 'number')
        return null
      const label = loc.name || loc.address || 'Геолокация'
      const link = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`
      const body = `📍 ${label}\n${link}`
      return { body, preview: '[Геолокация]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
    }
    default:
      return null
  }
}

/** Map a Cloud API delivery status string to our message status enum. */
function mapStatus(s?: string): 'sent' | 'delivered' | 'read' | 'failed' | null {
  if (s === 'sent' || s === 'delivered' || s === 'read' || s === 'failed') return s
  return null
}

/**
 * App-level inbound webhook for the Cloud API.
 *
 * Meta POSTs message events for ALL phone numbers here. We verify the
 * X-Hub-Signature-256 HMAC with the app secret (when configured), then for each
 * message use metadata.phone_number_id to find which number (channel) it belongs
 * to and route it to that number's assigned manager. Persists via
 * recordWhatsappInbound (realtime NOTIFY + de-dupe) and runs the manager's
 * autopilot — identical to the MAX/live-chat flow. No worker, no socket.
 *
 * Always returns 200 once authenticated so Meta doesn't retry-storm us.
 */
export async function POST(request: Request): Promise<Response> {
  // Inbound only needs the webhook secrets (app secret for signature checks) —
  // not the access token. So messages are received even before a sending token
  // is configured.
  const { verifyToken, appSecret } = await getWhatsappWebhookSecrets()
  if (!verifyToken) return json({ ok: false, error: 'not_configured' }, 503)

  // Read the raw body so we can verify the signature byte-for-byte.
  const raw = await request.text()

  // Verify X-Hub-Signature-256 when an app secret is configured. Without one we
  // can't verify, so we accept (admin opted out of signing).
  if (appSecret) {
    const sig = request.headers.get('x-hub-signature-256') ?? ''
    if (!verifySignature(raw, sig, appSecret)) {
      return json({ ok: false, error: 'bad_signature' }, 401)
    }
  } else {
    // No app secret configured: we cannot verify the payload really came from
    // Meta, so anyone who learns this URL could inject inbound messages. This is
    // an explicit opt-out — surface it loudly so an operator can lock it down by
    // adding the app secret under /admin/whatsapp.
    console.warn(
      '[v0] whatsapp webhook: accepting UNSIGNED payload — no app secret configured. ' +
        'Set the WhatsApp app secret in /admin/whatsapp to enable signature verification.',
    )
  }

  let body: WaWebhookBody
  try {
    body = JSON.parse(raw) as WaWebhookBody
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400)
  }

  let handled = 0

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value
      if (!value) continue

      // Delivery-status events (sent/delivered/read/failed) for OUR outbound
      // messages. These carry no `messages`, just `statuses`. Update by provider
      // id; the realtime trigger pushes the tick change to the panel.
      for (const s of value.statuses ?? []) {
        const st = mapStatus(s.status)
        if (!st || !s.id) continue
        try {
          await updateWhatsappMessageStatus(s.id, st)
          handled++
        } catch (err) {
          console.error('[v0] whatsapp webhook: status update failed:', err)
        }
      }

      if (!value.messages?.length) continue

      // Route by the phone number that received the message.
      const phoneNumberId = value.metadata?.phone_number_id
      if (!phoneNumberId) continue
      const route = await resolveWhatsappInboundByPhoneId(phoneNumberId)
      if (!route) continue // number not registered under this app
      const agentId = await resolveWhatsappAgentId(route)
      if (!agentId) continue // no live manager to route to

      // Map wa_id -> display name from the contacts block.
      const names = new Map<string, string>()
      for (const c of value.contacts ?? []) {
        if (c.wa_id) names.set(c.wa_id, c.profile?.name?.trim() || c.wa_id)
      }

      for (const m of value.messages) {
        const from = (m.from ?? '').trim()
        if (!from) continue
        // Text, media (photo/video/voice/audio/document/sticker) and location.
        const parsed = parseInbound(m)
        if (!parsed) continue

        try {
          const { conversationId, managerId, message } =
            await recordWhatsappInbound({
              channelId: route.channelId,
              pool: route.pool,
              fallbackManagerId: agentId,
              contactName: names.get(from) ?? from,
              contactHandle: from,
              body: parsed.body,
              preview: parsed.preview,
              mediaType: parsed.mediaType,
              mediaMime: parsed.mediaMime,
              mediaName: parsed.mediaName,
              mediaRef: parsed.mediaRef,
              replyToProviderId: m.context?.id ?? null,
              providerMessageId: m.id ?? null,
            })

          handled++

          // Skip the autopilot for duplicate webhook deliveries and for media
          // (the autopilot replies to text; media has no text to act on).
          if (message && parsed.body && !parsed.mediaType) {
            await runLivechatAutopilot({
              managerId,
              channelId: route.channelId,
              conversationId,
              text: parsed.body,
            })
          }
        } catch (err) {
          console.error('[v0] whatsapp webhook: ingest failed:', err)
        }
      }
    }
  }

  return json({ ok: true, handled })
}

/** HMAC-SHA256 verify of the raw body against the `sha256=...` header. */
function verifySignature(raw: string, header: string, secret: string): boolean {
  const expected =
    'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
