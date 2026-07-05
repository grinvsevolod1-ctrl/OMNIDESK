import { createHash, timingSafeEqual } from 'crypto'
import {
  getVkChannelById,
  recordVkInbound,
  resolveVkAgentId,
} from '@/lib/data'
import { runLivechatAutopilot } from '@/lib/autopilot/runtime'
import { getUser, vkUserName, type VkMessage, type VkUpdate } from '@/lib/vk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Constant-time secret comparison (hash both sides to equalize length). */
function secretMatches(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** Plain-text response helper (VK expects "ok" / the confirmation string). */
function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Inbound Callback API webhook for a VK community channel.
 *
 * VK (api.vk.com) POSTs every subscribed event here. Three things happen:
 *   1. `confirmation` — VK's handshake. We reply with the community's
 *      confirmation string (plain text), which we stored at connect time.
 *   2. Every other event carries the per-channel `secret` we set when
 *      registering the callback server; we verify it before doing anything.
 *   3. `message_new` events are persisted into the inbox via recordVkInbound
 *      (which fires the realtime NOTIFY), then the manager's autopilot runs —
 *      identical to the live-chat / MAX flow. No worker, no session.
 *
 * VK retries any event we don't answer with the literal string "ok" within a
 * few seconds, so we always reply "ok" once an event is accepted.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> },
): Promise<Response> {
  const { channelId } = await params

  const channel = await getVkChannelById(channelId)
  if (!channel) {
    return text('unknown_channel', 404)
  }

  let update: VkUpdate
  try {
    update = (await request.json()) as VkUpdate
  } catch {
    return text('invalid_json', 400)
  }

  // 1. Handshake: echo the confirmation string. (No secret is sent yet.)
  if (update.type === 'confirmation') {
    return text(channel.confirmationCode)
  }

  // 2. Authenticate every real event against our per-channel secret.
  if (!update.secret || !secretMatches(update.secret, channel.webhookSecret)) {
    return text('bad_secret', 403)
  }

  // 3. We only ingest new inbound messages. Other events are acknowledged so VK
  //    stops resending, but not persisted.
  if (update.type !== 'message_new') {
    return text('ok')
  }

  // Normalise the message across the modern ({ object: { message } }) and the
  // legacy ({ object: <message> }) Callback payload shapes.
  const message: VkMessage | undefined =
    update.object?.message ??
    (update.object && 'from_id' in update.object
      ? (update.object as VkMessage)
      : undefined)

  const body = (message?.text ?? '').trim()
  if (!message || !body) {
    return text('ok')
  }

  // Outbound (community) messages have a negative from_id; ignore our own echoes.
  const fromId = Number(message.from_id)
  if (!Number.isFinite(fromId) || fromId <= 0) {
    return text('ok')
  }
  const contactHandle = String(fromId)

  // Need at least one live manager to route the conversation to.
  const agentId = await resolveVkAgentId(channel)
  if (!agentId) {
    return text('ok')
  }

  // Resolve a human name for the contact (best-effort; falls back to "VK #id").
  let contactName = `VK #${contactHandle}`
  try {
    const user = await getUser(channel.token, contactHandle)
    if (user.ok) contactName = vkUserName(user.data, contactHandle)
  } catch {
    // keep the fallback name
  }

  try {
    const {
      conversationId,
      managerId,
      message: stored,
    } = await recordVkInbound({
      channelId: channel.id,
      pool: channel.pool,
      fallbackManagerId: agentId,
      contactName,
      contactHandle,
      body,
      providerMessageId:
        message.conversation_message_id != null
          ? String(message.conversation_message_id)
          : message.id != null
            ? String(message.id)
            : null,
    })

    // Autopilot: same engine as live-chat (no ban risk, reply sent instantly).
    // Self-guards all errors so it can never break ingestion. Skipped for
    // duplicate webhook deliveries (stored === null).
    if (stored) {
      await runLivechatAutopilot({
        managerId,
        channelId: channel.id,
        conversationId,
        text: body,
      })
    }

    return text('ok')
  } catch (err) {
    console.error('[v0] vk webhook: recordVkInbound failed:', err)
    // Reply "ok" anyway so VK doesn't retry-storm us on a transient DB error.
    return text('ok')
  }
}
