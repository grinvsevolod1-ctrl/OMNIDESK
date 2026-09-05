/**
 * Pure delivery-health checks for messaging channels, kept out of the data
 * layer so they can be unit-tested without a DB.
 */
import type { ChannelStatus, SessionStatus } from './types'

/**
 * Live session states in which a Telegram account cannot reliably deliver an
 * outbound message: it's offline, errored, logged out, or the worker backed off
 * because the provider is rate-limiting/restricting it. Used to decide when the
 * «Доработки» follow-up should silently fall back to the shared outreach
 * account instead of the impaired owning account.
 */
export const IMPAIRED_SESSION_STATUSES: readonly SessionStatus[] = [
  'offline',
  'error',
  'logged_out',
  'rate_limited',
]

/**
 * True when an outbound Telegram send on this account is unlikely to reach the
 * contact: our account is in the contact's block list, the channel is missing,
 * not connected, or its live session is impaired. Callers use this to trigger
 * the transparent outreach-account fallback.
 */
export function isTelegramDeliveryImpaired(
  channel: { status: ChannelStatus; sessionStatus: SessionStatus } | null,
  contactBlocked: boolean,
): boolean {
  if (contactBlocked) return true
  if (!channel) return true
  if (channel.status !== 'connected') return true
  return IMPAIRED_SESSION_STATUSES.includes(channel.sessionStatus)
}
