import 'server-only'
import { type ProxyDescriptor } from './proxy-agent'
import {
  VK_API_VERSION,
  vkCall as call,
  type VkGroup,
  type VkResult,
  type VkUser,
} from './vk-core'

/**
 * VK (vk.com) Community API client — https://dev.vk.com/method.
 *
 * VK has no legal API for automating personal accounts (that is a ban-worthy
 * ToS violation), so — exactly like MAX — we integrate at the *community* level:
 * the admin creates a community (group) access token with the `messages` +
 * `manage` scopes, and the bot only ever talks to users who messaged the
 * community first.
 *
 * Integration model mirrors MAX / live-chat (NOT the Telegram/WhatsApp worker):
 *   • Inbound  → VK Callback API POSTs events to our webhook route.
 *   • Outbound → sent directly from Next.js with `messages.send`.
 *
 * EVERY request is routed through the account's assigned proxy (when it has one)
 * via `proxiedFetch`, so all VK traffic exits from the account's dedicated IP —
 * consistent footprint, lower risk of restrictions.
 *
 * Module layout (this file is the public barrel — keep importing '@/lib/vk'):
 *   vk-core.ts   shared types, VkResult envelope, vkErrorText, vkCall transport
 *   vk-media.ts  attachment uploads (photo/doc) + inbound attachment parsing
 *   vk.ts        API methods (groups, callback server wiring, messaging)
 */

export {
  vkErrorText,
  type VkAttachment,
  type VkGroup,
  type VkMessage,
  type VkResult,
  type VkUpdate,
  type VkUser,
} from './vk-core'
export {
  parseVkAttachments,
  uploadDocAttachment,
  uploadPhotoAttachment,
  type ParsedVkMedia,
  type VkUploadedAttachment,
} from './vk-media'

/**
 * Resolve the community that owns this token. With a community access token,
 * groups.getById returns that community when no group_ids are passed. Used at
 * connect time to validate the token before we persist the channel.
 */
export async function getGroup(
  token: string,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<VkGroup>> {
  const res = await call<VkGroup[] | { groups?: VkGroup[] }>(
    'groups.getById',
    token,
    {},
    proxy,
  )
  if (!res.ok) return res
  // Newer API versions wrap the array in `{ groups: [...] }`; older ones return
  // a bare array. Normalise both.
  const list = Array.isArray(res.data) ? res.data : res.data.groups ?? []
  const group = list[0]
  if (!group) {
    return { ok: false, error: 'Не удалось определить сообщество по токену.' }
  }
  return { ok: true, data: group }
}

/**
 * Verify the community token actually carries the scopes we need before we try
 * to wire up the Callback API. Returns the list of missing scopes (empty when
 * the token is fully privileged) so the admin gets an exact, actionable error
 * instead of a cryptic failure three API calls later.
 *
 * `groups.getTokenPermissions` returns a bitmask + a `settings` array of
 * `{ name, setting }` for community tokens. We require `messages` (send/receive)
 * and `manage` (register the callback server).
 */
export async function checkTokenScopes(
  token: string,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<{ missing: string[] }>> {
  const res = await call<{
    mask?: number
    permissions?: { name?: string }[]
    settings?: { name?: string; setting?: number }[]
  }>('groups.getTokenPermissions', token, {}, proxy)
  if (!res.ok) return res
  const granted = new Set<string>()
  for (const p of res.data.permissions ?? []) if (p.name) granted.add(p.name)
  for (const p of res.data.settings ?? []) if (p.name) granted.add(p.name)
  const required = ['messages', 'manage']
  const missing = required.filter((s) => !granted.has(s))
  return { ok: true, data: { missing } }
}

/** Fetch the Callback API confirmation string VK expects us to echo back. */
export async function getConfirmationCode(
  token: string,
  groupId: number,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<string>> {
  const res = await call<{ code?: string }>(
    'groups.getCallbackConfirmationCode',
    token,
    { group_id: groupId },
    proxy,
  )
  if (!res.ok) return res
  if (!res.data.code) {
    return { ok: false, error: 'VK не вернул код подтверждения.' }
  }
  return { ok: true, data: res.data.code }
}

/**
 * Register a Callback API server (our webhook URL) for the community, protected
 * by `secret`. Returns the VK-assigned server id so we can later switch on
 * events / delete it. VK immediately probes the URL with a `confirmation`
 * request, so the webhook route must already be live.
 */
export async function addCallbackServer(
  token: string,
  groupId: number,
  url: string,
  secret: string,
  proxy?: ProxyDescriptor | null,
  title = 'Inbox',
): Promise<VkResult<{ server_id: number }>> {
  return call<{ server_id: number }>(
    'groups.addCallbackServer',
    token,
    { group_id: groupId, url, title, secret_key: secret },
    proxy,
  )
}

/** Switch on the `message_new` event for a registered callback server. */
export async function setCallbackSettings(
  token: string,
  groupId: number,
  serverId: number,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<number>> {
  return call<number>(
    'groups.setCallbackSettings',
    token,
    {
      group_id: groupId,
      server_id: serverId,
      api_version: VK_API_VERSION,
      message_new: 1,
    },
    proxy,
  )
}

/** Remove a previously-registered callback server (best-effort cleanup). */
export async function deleteCallbackServer(
  token: string,
  groupId: number,
  serverId: number,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<number>> {
  return call<number>(
    'groups.deleteCallbackServer',
    token,
    { group_id: groupId, server_id: serverId },
    proxy,
  )
}

/**
 * Send a message to a VK user. Addressed by peer_id (== the user's id for direct
 * dialogs, which is what we store as the contact handle). `random_id` dedupes
 * retries on VK's side. An optional `attachment` string (e.g. `photo123_456`)
 * carries media. Returns the provider message id on success.
 */
export async function sendMessage(
  token: string,
  peerId: string | number,
  text: string,
  proxy?: ProxyDescriptor | null,
  attachment?: string,
): Promise<VkResult<{ messageId: string | null }>> {
  const params: Record<string, string | number> = {
    peer_id: peerId,
    message: text,
    random_id: Math.floor(Math.random() * 2_000_000_000),
  }
  if (attachment) params.attachment = attachment
  const res = await call<number>('messages.send', token, params, proxy)
  if (!res.ok) return res
  return { ok: true, data: { messageId: res.data ? String(res.data) : null } }
}

/**
 * Toggle the "typing…" indicator for a dialog so the user sees the community is
 * responding. Best-effort — VK auto-clears it after ~10s. `type` may also be
 * 'audiomessage' / 'photo'; we only ever send 'typing'.
 */
export async function setActivity(
  token: string,
  peerId: string | number,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<number>> {
  return call<number>(
    'messages.setActivity',
    token,
    { peer_id: peerId, type: 'typing' },
    proxy,
  )
}

/**
 * Mark the dialog with `peerId` as read (the user sees their messages were
 * read). Best-effort; failures are non-fatal.
 */
export async function markAsRead(
  token: string,
  peerId: string | number,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<number>> {
  return call<number>(
    'messages.markAsRead',
    token,
    { peer_id: peerId },
    proxy,
  )
}

/** Look up a single user's profile so inbound conversations get a real name. */
export async function getUser(
  token: string,
  userId: string | number,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<VkUser | null>> {
  const res = await call<VkUser[]>(
    'users.get',
    token,
    { user_ids: userId, fields: 'screen_name,photo_100,online' },
    proxy,
  )
  if (!res.ok) return res
  return { ok: true, data: res.data[0] ?? null }
}

/** Human-readable display name for a VK user, with sensible fallbacks. */
export function vkUserName(
  user: VkUser | null | undefined,
  fallbackId: string | number,
): string {
  if (user) {
    const full = [user.first_name, user.last_name]
      .filter(Boolean)
      .join(' ')
      .trim()
    if (full) return full
    if (user.screen_name) return `@${user.screen_name}`
  }
  return `VK #${fallbackId}`
}
