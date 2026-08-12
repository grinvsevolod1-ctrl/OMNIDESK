/**
 * Shared anti-ban pacing primitives for the worker autopilot: per-channel
 * cooldown + hour/day rate caps, and the humanized "typing…" wait. Used by
 * both the canned-rule engine (autopilot.ts) and the AI-lead handler
 * (autopilot-ai-lead.ts) so messengers get identical send pacing regardless
 * of who composes the reply.
 */
import { logger } from './logger.js'
import * as repo from './repo.js'

/** Per-channel anti-ban caps for autopilot auto-sends (messengers only). */
const RATE_CAP_PER_HOUR = 20
const RATE_CAP_PER_DAY = 120
/** Minimum spacing between two autopilot sends on the SAME channel. */
const CHANNEL_COOLDOWN_MS = 8000

/** In-memory last-send timestamp per channel for the cooldown (best-effort). */
const lastSendByChannel = new Map<string, number>()

/** A session able to send a message to a contact handle. */
export interface SenderSession {
  sendMessage(
    target: string,
    body: string,
    opts?: { replyToMsgId?: number },
  ): Promise<{ providerMessageId: string | null }>
  /** Optional "typing…" presence while we wait (Telegram/WhatsApp support it). */
  sendTyping?(target: string, on: boolean): Promise<void>
}

/** Record a successful autopilot send for the per-channel cooldown. */
export function noteAutopilotSend(channelId: string): void {
  lastSendByChannel.set(channelId, Date.now())
}

/** True if sending now would exceed this channel's anti-ban rate caps. */
export async function withinRateCaps(channelId: string): Promise<boolean> {
  const last = lastSendByChannel.get(channelId) ?? 0
  if (Date.now() - last < CHANNEL_COOLDOWN_MS) return false
  const [hour, day] = await Promise.all([
    repo.countAutopilotSends(channelId, 60),
    repo.countAutopilotSends(channelId, 60 * 24),
  ])
  if (hour >= RATE_CAP_PER_HOUR) {
    logger.info({ channelId, hour }, 'autopilot: hourly cap reached, skipping')
    return false
  }
  if (day >= RATE_CAP_PER_DAY) {
    logger.info({ channelId, day }, 'autopilot: daily cap reached, skipping')
    return false
  }
  return true
}

/**
 * Hold a "typing…" presence for the whole humanized delay. Telegram expires
 * the indicator after ~6 seconds, so a single fire-and-forget call (the old
 * behavior) showed typing for a fraction of a 10–45s delay; re-send it every
 * 5s and explicitly cancel right before the message goes out. Best-effort:
 * presence must never delay or break the actual send.
 */
export async function typeWhileWaiting(
  session: SenderSession,
  target: string,
  delayMs: number,
): Promise<void> {
  if (!session.sendTyping) {
    await new Promise((r) => setTimeout(r, delayMs))
    return
  }
  const startedAt = Date.now()
  await session.sendTyping(target, true).catch(() => {})
  while (Date.now() - startedAt < delayMs) {
    const remaining = delayMs - (Date.now() - startedAt)
    await new Promise((r) => setTimeout(r, Math.min(5000, remaining)))
    if (Date.now() - startedAt < delayMs) {
      await session.sendTyping(target, true).catch(() => {})
    }
  }
  await session.sendTyping(target, false).catch(() => {})
}
