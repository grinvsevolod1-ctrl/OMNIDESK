import { createHash } from 'node:crypto'
import { getLivechatWidgetConfigByApiKey } from '@/lib/data'
import { resolveAppBaseUrl } from '@/lib/app-url'
import {
  clientIp,
  corsHeaders,
  originAllowed,
  preflight,
  tooMany,
} from '@/lib/livechat'
import { rateLimit } from '@/lib/rate-limit'
import { isOffHoursFor } from '@/lib/offhours'
import { getVapidPublicKey, isPushConfigured } from '@/lib/push'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Public widget configuration endpoint.
 *
 * The website widget fetches this on boot and re-polls it periodically (~15s)
 * so look & feel, content, messengers, working hours and auto-open behaviour
 * can be edited live from the admin and take effect on the site WITHOUT the
 * owner reinstalling the snippet.
 *
 * The off-hours decision is computed server-side from the site's own working
 * hours so it's authoritative and independent of the visitor's clock/timezone.
 *
 * Same auth/CORS model as the other live-chat endpoints: the API key
 * authenticates and the request Origin must match the channel's domain.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)

  // Polled by every open widget (~every 15s). Guard per IP against a tight
  // polling loop hammering the DB.
  const ipGuard = await rateLimit(`lc:config:ip:${clientIp(request.headers)}`, 120, 60_000)
  if (!ipGuard.allowed) return tooMany(cors, ipGuard.retryAfterSec)

  const apiKey = (url.searchParams.get('key') ?? '').trim()
  const resolved = apiKey
    ? await getLivechatWidgetConfigByApiKey(apiKey)
    : null
  if (!resolved) {
    return json({ ok: false, error: 'invalid_key' }, 401, cors)
  }
  const { channel, widget } = resolved
  if (!originAllowed(origin, channel)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403, cors)
  }

  // Keep the heavy avatar OUT of this frequently-polled payload: if it's an
  // inline data URL, swap it for a stable, separately-cacheable endpoint URL so
  // the ~256KB image is fetched once (and revalidated via its own ETag) instead
  // of riding along on every 15s poll. Hosted (http) avatars are left as-is.
  if (widget.appearance.agentAvatar.startsWith('data:')) {
    try {
      const base = await resolveAppBaseUrl()
      widget.appearance.agentAvatar = `${base}/api/livechat/avatar?key=${encodeURIComponent(apiKey)}`
    } catch {
      // Couldn't resolve an absolute base — drop the inline data URL rather than
      // ship 256KB on every poll. The widget falls back to its default icon.
      widget.appearance.agentAvatar = ''
    }
  }

  const offHours = isOffHoursFor(widget.workingHours)

  const bodyObj = {
    ok: true,
    // The integration is considered usable unless explicitly turned off.
    active: channel.status !== 'disconnected',
    offHours,
    config: widget,
    // Public VAPID key so the widget can subscribe the visitor to Web Push
    // without hardcoding it. null when push isn't configured on the server, in
    // which case the widget simply skips push subscription.
    vapidPublicKey: isPushConfigured() ? getVapidPublicKey() : null,
  }
  const body = JSON.stringify(bodyObj)

  // ETag/304: the widget re-polls every ~15s but the config rarely changes, so
  // let the browser revalidate cheaply and skip re-downloading an identical body.
  const etag = '"' + createHash('sha1').update(body).digest('hex').slice(0, 32) + '"'
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ...cors, etag, 'cache-control': 'no-cache' },
    })
  }

  return new Response(body, {
    status: 200,
    headers: {
      ...cors,
      'content-type': 'application/json',
      etag,
      'cache-control': 'no-cache',
    },
  })
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
