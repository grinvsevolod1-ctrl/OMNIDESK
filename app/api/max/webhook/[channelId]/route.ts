import { createHash, timingSafeEqual } from 'crypto'
import {
  getMaxChannelById,
  recordMaxInbound,
  resolveMaxAgentId,
} from '@/lib/data'
import { runLivechatAutopilot } from '@/lib/autopilot/runtime'
import { rateLimit } from '@/lib/rate-limit'
import { maxUserName, type MaxUpdate } from '@/lib/max'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Constant-time secret comparison (hash both sides to equalize length). */
function secretMatches(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/**
 * Inbound webhook for a MAX bot channel.
 *
 * MAX (botapi.max.ru) POSTs every subscribed update here. We authenticate with
 * the per-channel secret echoed in the `X-Max-Bot-Api-Secret` header (set when
 * we registered the subscription), persist `message_created` events into the
 * inbox via recordMaxInbound (which fires the realtime NOTIFY), then run the
 * manager's autopilot — identical to the live-chat flow. No worker, no session.
 *
 * Always returns 200 on success so MAX doesn't retry-storm us; genuine auth
 * failures return 401/404.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> },
): Promise<Response> {
  const { channelId } = await params

  // Anti-flood guard BEFORE any DB work. The webhook is protected by a
  // per-channel secret, but if it ever leaks this caps how hard one channel
  // endpoint can hammer the database. Generous enough for real MAX traffic.
  // We ack 200 so MAX doesn't retry-storm us while we're shedding load.
  const floodGuard = rateLimit(`max:webhook:${channelId}`, 120, 60_000)
  if (!floodGuard.allowed) return json({ ok: true, throttled: true })

  const channel = await getMaxChannelById(channelId)
  if (!channel) {
    return json({ ok: false, error: 'unknown_channel' }, 404)
  }

  // Verify the request really came from MAX (the secret we set at subscribe).
  const secret = request.headers.get('x-max-bot-api-secret')
  if (!secret || !secretMatches(secret, channel.webhookSecret)) {
    return json({ ok: false, error: 'bad_secret' }, 401)
  }

  let update: MaxUpdate
  try {
    update = (await request.json()) as MaxUpdate
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400)
  }

  // We only ingest text messages. Other update types (bot_started, callbacks,
  // edits, …) are acknowledged so MAX stops resending, but not persisted.
  if (update.update_type !== 'message_created' || !update.message) {
    return json({ ok: true, ignored: update.update_type })
  }

  const message = update.message
  const text = (message.body?.text ?? '').trim()
  if (!text) {
    return json({ ok: true, ignored: 'empty' })
  }

  const sender = message.sender
  // Address replies by the sender's numeric user_id. Fall back to the dialog
  // user_id on the recipient block if the sender id is somehow absent.
  const contactHandle = String(
    sender?.user_id ?? message.recipient?.user_id ?? '',
  ).trim()
  if (!contactHandle) {
    return json({ ok: true, ignored: 'no_sender' })
  }

  // Need at least one live manager to route the conversation to.
  const agentId = await resolveMaxAgentId(channel)
  if (!agentId) {
    return json({ ok: true, noAgents: true })
  }

  try {
    const {
      conversationId,
      managerId,
      message: stored,
    } = await recordMaxInbound({
      channelId: channel.id,
      pool: channel.pool,
      fallbackManagerId: agentId,
      contactName: maxUserName(sender),
      contactHandle,
      body: text,
      providerMessageId: message.body?.mid ?? null,
    })

    // Autopilot: same engine as live-chat (no ban risk, reply sent instantly).
    // Self-guards all errors so it can never break ingestion. Skipped for
    // duplicate webhook deliveries (stored === null).
    if (stored) {
      await runLivechatAutopilot({
        managerId,
        channelId: channel.id,
        conversationId,
        text,
      })
    }

    return json({ ok: true, conversationId })
  } catch (err) {
    console.error('[v0] max webhook: recordMaxInbound failed:', err)
    return json({ ok: false, error: 'server_error' }, 500)
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
