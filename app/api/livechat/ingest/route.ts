import {
  getLivechatChannelByApiKey,
  getLivechatConversationRef,
  recordLivechatInbound,
  recordLivechatPendingLead,
  resolveLivechatAgentId,
} from '@/lib/data'
import { runLivechatAutopilot } from '@/lib/autopilot/runtime'
import {
  clientIp,
  corsHeaders,
  messageBody,
  originAllowed,
  preflight,
  tooMany,
  visitorHandle,
  visitorName,
} from '@/lib/livechat'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Inbound endpoint for website live-chat widgets.
 *
 * Flow: visitor types in the widget -> widget POSTs here with its API key ->
 * we persist the message (recordLivechatInbound) -> Postgres triggers fire
 * pg_notify('realtime') -> the agent's inbox SSE stream pushes it live.
 *
 * Auth is the per-channel API key (config.apiKey). No session cookie — this is
 * called cross-origin from the customer's site.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)
  const ip = clientIp(request.headers)

  // Cheap per-IP guard FIRST, before any DB work, so a flood can't hammer the
  // database. Generous enough for real users behind shared NAT.
  const ipGuard = rateLimit(`lc:ingest:ip:${ip}`, 60, 60_000)
  if (!ipGuard.allowed) return tooMany(cors, ipGuard.retryAfterSec)

  let payload: {
    key?: string
    visitor?: string
    name?: string
    message?: string
    meta?: {
      language?: string
      timezone?: string
      screen?: string
      page?: string
      referrer?: string
      subject?: string
    }
  }
  try {
    payload = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400, cors)
  }

  const apiKey = String(payload.key ?? '').trim()
  if (!apiKey) {
    return json({ ok: false, error: 'missing_key' }, 401, cors)
  }

  let channel
  try {
    channel = await getLivechatChannelByApiKey(apiKey)
  } catch (err) {
    console.error('[v0] ingest: getLivechatChannelByApiKey threw (DB error?):', err)
    return json({ ok: false, error: 'server_error' }, 500, cors)
  }
  if (!channel) {
    return json({ ok: false, error: 'invalid_key' }, 401, cors)
  }

  if (!originAllowed(origin, channel)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403, cors)
  }

  // Channel turned off in the admin: stop accepting messages on a deactivated
  // integration (the widget hides itself via the stream's `disabled` event).
  if (channel.status === 'disconnected') {
    return json({ ok: false, error: 'disabled' }, 403, cors)
  }

  const body = messageBody(payload.message)
  if (!body) {
    return json({ ok: false, error: 'empty_message' }, 400, cors)
  }

  const handle = visitorHandle(payload.visitor)
  const name = visitorName(payload.name)

  // Per-visitor message throttle: stops a single (possibly spoofed) visitor id
  // from spamming one channel's inbox while staying well above human typing.
  const visitorGuard = rateLimit(
    `lc:ingest:v:${channel.id}:${handle}`,
    20,
    60_000,
  )
  if (!visitorGuard.allowed) return tooMany(cors, visitorGuard.retryAfterSec)

  // Anti-flood: a brand-new conversation is the expensive event (it creates a
  // row, bumps the visitor sequence and lands in a manager's inbox). Cap how
  // many *new* threads one IP can open in a short window. Existing threads are
  // unaffected, so a real ongoing chat never trips this.
  let existingRef
  try {
    existingRef = await getLivechatConversationRef(channel.id, handle)
  } catch (err) {
    console.error('[v0] ingest: getLivechatConversationRef threw:', err)
    return json({ ok: false, error: 'server_error' }, 500, cors)
  }
  if (!existingRef) {
    const newConvGuard = rateLimit(`lc:newconv:${ip}`, 6, 10 * 60_000)
    if (!newConvGuard.allowed) return tooMany(cors, newConvGuard.retryAfterSec)
  }

  // The chat is always reachable, but it can only accept a message when there
  // is a manager to route it to. If every manager has been removed we reply
  // with noAgents so the widget shows a friendly "we can't answer right now"
  // notice instead of silently dropping (or violating the conversations FK).
  let agentId
  try {
    agentId = await resolveLivechatAgentId(channel)
  } catch (err) {
    console.error('[v0] ingest: resolveLivechatAgentId threw (DB error?):', err)
    return json({ ok: false, error: 'server_error' }, 500, cors)
  }
  if (!agentId) {
    // No manager exists to own a conversation, but we must NOT lose the lead.
    // Persist the attempt so the text/contact survives until a manager returns.
    await recordLivechatPendingLead({
      channelId: channel.id,
      contactName: name,
      contactHandle: handle,
      body,
      meta: {
        ip: ip !== 'unknown' ? ip : undefined,
        userAgent: request.headers.get('user-agent') ?? undefined,
        language: payload.meta?.language,
        timezone: payload.meta?.timezone,
        page: payload.meta?.page,
        referrer: payload.meta?.referrer,
        subject: payload.meta?.subject,
      },
    })
    return json({ ok: true, noAgents: true }, 200, cors)
  }

  // Visitor context: IP is captured server-side from proxy headers (never
  // trusted from the client); the rest comes from the widget. All optional.
  const headers = request.headers
  const clientMeta = payload.meta ?? {}

  try {
    const { conversationId, managerId, message } = await recordLivechatInbound({
      channelId: channel.id,
      pool: channel.pool,
      // Guaranteed-alive manager (checked above) used when the round-robin
      // pool is empty or resolves to a removed manager.
      fallbackManagerId: agentId,
      contactName: name,
      contactHandle: handle,
      body,
      meta: {
        ip: ip !== 'unknown' ? ip : undefined,
        userAgent: headers.get('user-agent') ?? undefined,
        language: clientMeta.language,
        timezone: clientMeta.timezone,
        screen: clientMeta.screen,
        page: clientMeta.page,
        referrer: clientMeta.referrer,
        subject: clientMeta.subject,
      },
    })

    // Autopilot: evaluate the manager's auto-reply rules and (if one matches)
    // send the reply now. Awaited so the outbound is recorded before we respond
    // — the DB notify trigger then pushes it to the widget. Self-guards all
    // errors, so an autopilot failure can never break message ingestion.
    await runLivechatAutopilot({
      managerId,
      channelId: channel.id,
      conversationId,
      text: body,
    })

    return json(
      {
        ok: true,
        conversationId,
        message: {
          id: message.id,
          direction: message.direction,
          body: message.body,
          createdAt: message.createdAt,
        },
      },
      200,
      cors,
    )
  } catch (err) {
    console.error('[v0] ingest: recordLivechatInbound failed:', err)
    return json({ ok: false, error: 'server_error' }, 500, cors)
  }
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
