import { z } from 'zod'
import { getLivechatChannelByApiKey, recordMessengerClick } from '@/lib/data'
import { inputErrorResponse, readJson } from '@/lib/http/request'
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

const trackSchema = z.object({
  key: z.string().trim().min(1).max(256),
  messenger: z.enum(['telegram', 'whatsapp']),
}).strict()

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

  let payload: z.infer<typeof trackSchema>
  try {
    payload = await readJson(request, trackSchema, 2 * 1024)
  } catch (error) {
    const response = inputErrorResponse(error)
    return json({ ok: false, error: response ? 'validation_error' : 'bad_request' }, response?.status ?? 400, cors)
  }

  const apiKey = payload.key
  const messenger = payload.messenger

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
