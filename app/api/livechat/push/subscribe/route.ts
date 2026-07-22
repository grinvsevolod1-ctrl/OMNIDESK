import { z } from 'zod'
import { getLivechatChannelByApiKey } from '@/lib/data'
import { inputErrorResponse, readJson } from '@/lib/http/request'
import {
  clientIp,
  corsHeaders,
  originAllowed,
  preflight,
  tooMany,
  visitorHandle,
} from '@/lib/livechat'
import { isPushConfigured, saveVisitorSubscription } from '@/lib/push'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const pushSchema = z.object({
  key: z.string().trim().min(1).max(256),
  visitor: z.string().max(256).optional(),
  subscription: z.object({
    endpoint: z.url().max(4096),
    keys: z.object({
      p256dh: z.string().min(1).max(1024),
      auth: z.string().min(1).max(1024),
    }).strict(),
  }).strict(),
}).strict()

/**
 * Stores a website visitor's Web Push subscription so operator/autopilot replies
 * can reach them even when no tab is open.
 *
 * The subscription is created on the customer's OWN origin (by the visitor
 * service worker the widget registers, see public/widget-sw.js) using our VAPID
 * public key, then POSTed here. We scope it by channel + normalized visitor
 * handle — exactly
 * the same key the ingest route and the push dispatcher use — so a reply to that
 * conversation finds the right device(s).
 *
 * Same auth/CORS model as the other live-chat endpoints: the per-channel API key
 * authenticates and the request Origin must match the channel's domain policy.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)
  const ip = clientIp(request.headers)

  // Cheap per-IP guard before any DB work.
  const ipGuard = rateLimit(`lc:push:ip:${ip}`, 30, 60_000)
  if (!ipGuard.allowed) return tooMany(cors, ipGuard.retryAfterSec)

  let payload: z.infer<typeof pushSchema>
  try {
    payload = await readJson(request, pushSchema, 12 * 1024)
  } catch (error) {
    const response = inputErrorResponse(error)
    return json({ ok: false, error: response ? 'validation_error' : 'invalid_json' }, response?.status ?? 400, cors)
  }

  const apiKey = String(payload.key ?? '').trim()
  if (!apiKey) {
    return json({ ok: false, error: 'missing_key' }, 401, cors)
  }

  let channel
  try {
    channel = await getLivechatChannelByApiKey(apiKey)
  } catch (err) {
    console.error('push/subscribe: getLivechatChannelByApiKey threw:', err)
    return json({ ok: false, error: 'server_error' }, 500, cors)
  }
  if (!channel) {
    return json({ ok: false, error: 'invalid_key' }, 401, cors)
  }

  if (!originAllowed(origin, channel)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403, cors)
  }

  // Nothing to store against if the server can't send push at all.
  if (!isPushConfigured()) {
    return json({ ok: false, error: 'push_not_configured' }, 503, cors)
  }

  const sub = payload.subscription
  const endpoint = String(sub?.endpoint ?? '').trim()
  const p256dh = String(sub?.keys?.p256dh ?? '').trim()
  const auth = String(sub?.keys?.auth ?? '').trim()
  if (!endpoint || !p256dh || !auth) {
    return json({ ok: false, error: 'invalid_subscription' }, 400, cors)
  }

  const handle = visitorHandle(payload.visitor)

  try {
    await saveVisitorSubscription(
      channel.id,
      handle,
      { endpoint, p256dh, auth },
      request.headers.get('user-agent'),
    )
  } catch (err) {
    console.error('push/subscribe: saveVisitorSubscription failed:', err)
    return json({ ok: false, error: 'server_error' }, 500, cors)
  }

  return json({ ok: true }, 200, cors)
}

export function OPTIONS(request: Request): Response {
  return preflight(request.headers.get('origin'))
}

function json(
  data: unknown,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  })
}
