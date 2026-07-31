/**
 * Replay processor for the inbound webhook dead-letter queue (migration 075 +
 * lib/data/webhook-dead-letter.ts).
 *
 * Runs in the panel process (where ingest + autopilot live), driven on a
 * schedule by /api/cron/retry-dead-letters. For each due row it re-resolves the
 * live channel and a current agent (the stored pool/manager may be stale), then
 * replays the exact normalized inbound through the same recordXInbound path the
 * webhook uses — so a message that failed on a transient error still lands in
 * the inbox and triggers autopilot, with exponential backoff between attempts.
 */
import {
  claimDueDeadLetters,
  markDeadLetterResolved,
  markRetryFailed,
  recordWebhookDeadLetter,
  type DeadLetterRecord,
} from './data/webhook-dead-letter'
import {
  getVkChannelById,
  resolveVkAgentId,
  recordVkInbound,
} from './data/vk'
import {
  getMaxChannelById,
  resolveMaxAgentId,
  recordMaxInbound,
} from './data/max'
import { runLivechatAutopilot } from './autopilot/runtime'
import { log } from './server-log'

/**
 * Replay a single dead-letter. Throws on failure so the caller records the
 * attempt + backoff; returns normally on success (already marked resolved).
 */
async function replayOne(row: DeadLetterRecord): Promise<void> {
  const payload = row.payload as {
    contactName?: string
    contactHandle?: string
    body?: string
    providerMessageId?: string | null
    preview?: string
    mediaType?: unknown
    mediaMime?: unknown
    mediaName?: unknown
    mediaRef?: unknown
  }
  const body = (payload.body ?? '').toString()
  const contactHandle = (payload.contactHandle ?? row.contactHandle).toString()

  if (row.channelType === 'vk') {
    const channel = await getVkChannelById(row.channelId)
    if (!channel) throw new Error('channel_gone')
    const agentId = await resolveVkAgentId(channel)
    if (!agentId) throw new Error('no_agents')

    const { conversationId, managerId, message } = await recordVkInbound({
      channelId: channel.id,
      pool: channel.pool,
      fallbackManagerId: agentId,
      contactName: payload.contactName ?? `VK #${contactHandle}`,
      contactHandle,
      body,
      preview: payload.preview,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mediaType: (payload.mediaType ?? null) as any,
      mediaMime: (payload.mediaMime ?? null) as string | null,
      mediaName: (payload.mediaName ?? null) as string | null,
      mediaRef: (payload.mediaRef ?? null) as Record<string, unknown> | null,
      providerMessageId: payload.providerMessageId ?? row.providerMessageId,
    })
    if (message && body) {
      await runLivechatAutopilot({
        managerId,
        channelId: channel.id,
        conversationId,
        text: body,
      })
    }
    return
  }

  // MAX
  const channel = await getMaxChannelById(row.channelId)
  if (!channel) throw new Error('channel_gone')
  const agentId = await resolveMaxAgentId(channel)
  if (!agentId) throw new Error('no_agents')

  const { conversationId, managerId, message } = await recordMaxInbound({
    channelId: channel.id,
    pool: channel.pool,
    fallbackManagerId: agentId,
    contactName: payload.contactName ?? `MAX #${contactHandle}`,
    contactHandle,
    body,
    providerMessageId: payload.providerMessageId ?? row.providerMessageId,
  })
  if (message && body) {
    await runLivechatAutopilot({
      managerId,
      channelId: channel.id,
      conversationId,
      text: body,
    })
  }
}

/**
 * Process one batch of due dead-letters. Safe to call repeatedly (claims are
 * atomic via SKIP LOCKED). Returns a summary for the cron response/logs.
 */
export async function processDeadLetterQueue(
  limit = 20,
): Promise<{ claimed: number; resolved: number; failed: number }> {
  const rows = await claimDueDeadLetters(limit)
  let resolved = 0
  let failed = 0

  for (const row of rows) {
    try {
      await replayOne(row)
      await markDeadLetterResolved(row.id)
      resolved++
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      await markRetryFailed(row.id, row.attempts, row.maxAttempts, message)
      log.warn('webhook-replay', 'retry_failed', {
        id: row.id,
        channelType: row.channelType,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        err: message,
      })
    }
  }

  return { claimed: rows.length, resolved, failed }
}

/**
 * Best-effort helper for webhook handlers: park a failed inbound in the queue.
 * Never throws (a dead-letter failure must not mask the original error).
 */
export async function deadLetterInbound(input: {
  channelType: 'vk' | 'max'
  channelId: string
  contactHandle: string
  providerMessageId?: string | null
  payload: Record<string, unknown>
  error: unknown
}): Promise<void> {
  try {
    await recordWebhookDeadLetter({
      channelType: input.channelType,
      channelId: input.channelId,
      contactHandle: input.contactHandle,
      providerMessageId: input.providerMessageId ?? null,
      payload: input.payload,
      error: input.error instanceof Error ? input.error.message : String(input.error),
    })
  } catch (err) {
    log.error('webhook-replay', 'dead_letter_persist_failed', { err })
  }
}
