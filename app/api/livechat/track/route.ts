import { getLivechatChannelByApiKey, recordMessengerClick } from '@/lib/data'
import {
  clientIp,
  corsHeaders,
  originAllowed,
  preflight,
  tooMany,
} from '@/lib/livechat'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Records a chat → messenger transition from the website live-chat widget.
 *
 * The off-hours screen shows Telegram/WhatsApp links; when a visitor taps one,
 * the widget posts here so the transition is counted in the overview analytics
 * and against the configured conversion goals. Same auth/CORS model as the other
 * live-chat endpoints (API key + allowed origin), so it can't be spammed from
 * arbitrary sites.
 *
 * Body: { key: string, messenger: 'telegram' | 'whatsapp' }
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)

  // Conversion tracking must not be inflatable: cap clicks per IP so the
  // analytics/goals can't be skewed by a script hammering this endpoint.
  const ipGuard = rateLimit(`lc:track:ip:${clientIp(request.headers)}`, 30, 60_000)
  if (!ipGuard.allowed) return tooMany(cors, ipGuard.retryAfterSec)

  let payload: { key?: unknown; messenger?: unknown } = {}
  try {
    payload = await request.json()
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400, cors)
  }

  const apiKey = String(payload.key ?? '').trim()
  const messenger = String(payload.messenger ?? '').trim()
  if (messenger !== 'telegram' && messenger !== 'whatsapp') {
    return json({ ok: false, error: 'bad_messenger' }, 400, cors)
  }

  const channel = apiKey ? await getLivechatChannelByApiKey(apiKey) : null
  if (!channel) return json({ ok: false, error: 'invalid_key' }, 401, cors)
  if (!originAllowed(origin, channel)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403, cors)
  }

  await recordMessengerClick(channel.id, messenger)
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
