import { createHash } from 'node:crypto'
import { getLivechatWidgetConfigByApiKey } from '@/lib/data'
import {
  clientIp,
  corsHeaders,
  preflight,
  tooMany,
} from '@/lib/livechat'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Serve the live-chat agent avatar as a cacheable image, decoupled from the
 * frequently-polled /config endpoint.
 *
 * Avatars are stored as downscaled data URLs in the widget config (up to
 * ~256KB). Previously they rode along in every /config poll (~4×/min per open
 * widget) — a lot of wasted bandwidth and DB JSON. /config now returns a URL
 * pointing here instead, and this endpoint emits long-lived cache headers plus
 * an ETag derived from the image bytes, so browsers fetch it once and only
 * re-download when the admin actually changes the avatar.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)

  const ipGuard = rateLimit(`lc:avatar:ip:${clientIp(request.headers)}`, 120, 60_000)
  if (!ipGuard.allowed) return tooMany(cors, ipGuard.retryAfterSec)

  const apiKey = (url.searchParams.get('key') ?? '').trim()
  const resolved = apiKey ? await getLivechatWidgetConfigByApiKey(apiKey) : null
  if (!resolved) {
    return new Response('Not found', { status: 404, headers: cors })
  }

  const avatar = resolved.widget.appearance.agentAvatar
  if (!avatar) {
    return new Response('Not found', { status: 404, headers: cors })
  }

  // Already a plain URL → just redirect (admin pasted a hosted image).
  if (/^https?:\/\//i.test(avatar)) {
    return new Response(null, {
      status: 302,
      headers: { ...cors, location: avatar },
    })
  }

  // Expect a data URL: data:<mime>;base64,<payload>
  const comma = avatar.indexOf(',')
  if (!avatar.startsWith('data:') || comma === -1) {
    return new Response('Not found', { status: 404, headers: cors })
  }
  const header = avatar.slice(5, comma) // between "data:" and ","
  const payload = avatar.slice(comma + 1)
  const isBase64 = /;base64$/i.test(header)
  const mime = (isBase64 ? header.replace(/;base64$/i, '') : header) || 'image/png'

  let bytes: Buffer
  try {
    bytes = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
  } catch {
    return new Response('Not found', { status: 404, headers: cors })
  }

  const etag = '"' + createHash('sha1').update(bytes).digest('hex').slice(0, 32) + '"'

  // Conditional request: nothing changed → 304, no body.
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ...cors, etag, 'cache-control': 'public, max-age=86400' },
    })
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...cors,
      'content-type': mime,
      etag,
      // Stable URL (keyed by apiKey); the ETag busts the cache when the admin
      // changes the avatar, so a day-long cache is safe and cheap.
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  })
}

export function OPTIONS(request: Request): Response {
  return preflight(request.headers.get('origin'))
}
