import { z } from 'zod'
import {
  getLivechatChannelByApiKey,
  getLivechatConversationRef,
} from '@/lib/data'
import {
  clientIp,
  corsHeaders,
  originAllowed,
  preflight,
  tooMany,
  visitorHandle,
  visitorName,
} from '@/lib/livechat'
import { inputErrorResponse, readJson } from '@/lib/http/request'
import { rateLimit } from '@/lib/rate-limit'
import { publishRealtime } from '@/lib/realtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const typingSchema = z.object({
  key: z.string().trim().min(1).max(256),
  visitor: z.string().max(256).optional(),
  name: z.string().max(200).optional(),
  typing: z.boolean().optional(),
  draft: z.string().max(500).optional(),
}).strict()

/**
 * Ephemeral "visitor is typing" ping from the website widget.
 *
 * The widget POSTs here (throttled) as the visitor types. We authenticate by
 * API key + origin exactly like the ingest endpoint, resolve the EXISTING
 * conversation (so we know which manager to notify), then publish a `typing`
 * realtime event scoped to that manager. Nothing is written to the database —
 * the event fans out via pg_notify to the manager's SSE stream and disappears.
 *
 * The live draft is included so the manager can see what the visitor is writing
 * in real time. It's clamped to a sane length and never persisted.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)

  // Ephemeral, high-frequency endpoint: guard per IP so it can't be abused to
  // flood managers' inboxes with typing pings, while staying well above the
  // widget's own throttle for real typing.
  const ipGuard = await rateLimit(`lc:typing:ip:${clientIp(request.headers)}`, 240, 60_000)
  if (!ipGuard.allowed) return tooMany(cors, ipGuard.retryAfterSec)

  let payload: z.infer<typeof typingSchema>
  try {
    payload = await readJson(request, typingSchema, 4 * 1024)
  } catch (error) {
    const response = inputErrorResponse(error)
    return new Response(response?.body, { status: response?.status ?? 400, headers: cors })
  }

  const apiKey = String(payload.key ?? '').trim()
  const channel = apiKey ? await getLivechatChannelByApiKey(apiKey) : null
  if (!channel) {
    return new Response('Unauthorized', { status: 401, headers: cors })
  }
  if (!originAllowed(origin, channel)) {
    return new Response('Forbidden', { status: 403, headers: cors })
  }

  const handle = visitorHandle(payload.visitor)
  const ref = await getLivechatConversationRef(channel.id, handle)
  // No conversation yet → nobody to notify. Acknowledge so the widget doesn't
  // retry; typing previews only matter once a thread exists.
  if (!ref) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
    })
  }

  const typing = payload.typing !== false
  // Clamp the live draft; never store it, just forward for the preview.
  const draft = typing ? String(payload.draft ?? '').slice(0, 500) : ''

  await publishRealtime({
    type: 'typing',
    actor: 'visitor',
    managerId: ref.managerId,
    channelId: channel.id,
    conversationId: ref.id,
    contactHandle: handle,
    contactName: visitorName(payload.name),
    typing,
    draft,
  })

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...cors, 'content-type': 'application/json' },
  })
}

export function OPTIONS(request: Request): Response {
  return preflight(request.headers.get('origin'))
}
