import { createHash, timingSafeEqual } from 'crypto'
import {
  getMaxChannelById,
  markInboundDeletedByProviderId,
  recordMaxInbound,
  recordMessageEditByProviderId,
  resolveMaxAgentId,
} from '@/lib/data'
import { runLivechatAutopilot } from '@/lib/autopilot/runtime'
import { HttpInputError, parseJsonBytes, readBodyBytes } from '@/lib/http/request'
import { rateLimit } from '@/lib/rate-limit'
import { log } from '@/lib/server-log'
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
    update = parseJsonBytes(await readBodyBytes(request, 256 * 1024)) as MaxUpdate
  } catch (error) {
    return json(
      { ok: false, error: error instanceof HttpInputError ? error.code : 'invalid_json' },
      error instanceof HttpInputError ? error.status : 400,
    )
  }

  // Edits: the contact edited a message. Snapshot the prior version into history
  // and overwrite the live row so the panel keeps the full before/after trail.
  if (update.update_type === 'message_edited' && update.message) {
    const mid = update.message.body?.mid
    const text = (update.message.body?.text ?? '').trim()
    if (mid) {
      try {
        await recordMessageEditByProviderId(channel.id, mid, { body: text })
      } catch (err) {
        log.error('max.webhook', 'edit_apply_failed', {
          err,
          channelId: channel.id,
          providerId: mid,
        })
      }
    }
    return json({ ok: true, edited: mid })
  }

  // Deletions: the contact removed a message. Soft-delete it, keeping the stored
  // text/media so it stays fully viewable in the panel.
  if (update.update_type === 'message_removed') {
    const mid = update.message_id ?? update.message?.body?.mid
    if (mid) {
      try {
        await markInboundDeletedByProviderId(channel.id, String(mid))
      } catch (err) {
        log.error('max.webhook', 'delete_apply_failed', {
          err,
          channelId: channel.id,
          providerId: String(mid),
        })
      }
    }
    return json({ ok: true, removed: mid })
  }

  // We only ingest text messages. Other update types (bot_started, callbacks, …)
  // are acknowledged so MAX stops resending, but not persisted.
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
    // Dead-letter: unlike a successful ingest, we return 500 so MAX retries the
    // delivery (its retry window is more forgiving than VK's). Still log it as a
    // dead_letter with full context so a message that never succeeds across
    // retries is greppable/replayable from pm2 logs rather than lost silently.
    log.error('max.webhook', 'inbound_dropped', {
      err,
      deadLetter: true,
      channelId: channel.id,
      contactHandle,
      providerMessageId: message.body?.mid ?? null,
    })
    return json({ ok: false, error: 'server_error' }, 500)
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
