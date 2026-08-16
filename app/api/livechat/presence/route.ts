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

const PRESENCE_STATES = ['open', 'minimized', 'away', 'left'] as const
type PresenceState = (typeof PRESENCE_STATES)[number]
const presenceSchema = z.object({
  key: z.string().trim().min(1).max(256),
  visitor: z.string().max(256).optional(),
  name: z.string().max(200).optional(),
  state: z.enum(PRESENCE_STATES),
}).strict()

function ok(cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...cors, 'content-type': 'application/json' },
  })
}

/**
 * Ephemeral "visitor presence" ping from the website widget.
 *
 * Mirrors the typing endpoint exactly (API key + origin auth, resolve the
 * EXISTING conversation, publish a scoped realtime event, store nothing). The
 * widget POSTs here when the visitor opens/closes the chat, switches tabs, or
 * leaves the page (the "left" ping is sent via navigator.sendBeacon on unload),
 * plus a periodic heartbeat so the inbox can detect a silently-lost visitor.
 *
 * Presence only matters once a conversation exists (otherwise there's no
 * manager to notify), so a missing conversation is acknowledged and ignored —
 * identical to typing.
 *
 * Body: { key, visitor, name, state: 'open'|'minimized'|'away'|'left' }
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)

  // Per-IP guard for this ephemeral heartbeat endpoint.
  const ipGuard = await rateLimit(`lc:presence:ip:${clientIp(request.headers)}`, 120, 60_000)
  if (!ipGuard.allowed) return tooMany(cors, ipGuard.retryAfterSec)

  let payload: z.infer<typeof presenceSchema>
  try {
    payload = await readJson(request, presenceSchema, 2 * 1024)
  } catch (error) {
    const response = inputErrorResponse(error)
    return new Response(response?.body, { status: response?.status ?? 400, headers: cors })
  }

  const state: PresenceState = payload.state

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
  // retry; presence only matters once a thread exists.
  if (!ref) return ok(cors)

  await publishRealtime({
    type: 'presence',
    actor: 'visitor',
    managerId: ref.managerId,
    channelId: channel.id,
    conversationId: ref.id,
    contactHandle: handle,
    contactName: visitorName(payload.name),
    presence: state,
  })

  return ok(cors)
}

export function OPTIONS(request: Request): Response {
  return preflight(request.headers.get('origin'))
}
