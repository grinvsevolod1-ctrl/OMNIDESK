import 'server-only'

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
 *   • Inbound  → VK Callback API POSTs events to our webhook route. No socket,
 *                no worker, no anti-ban pacing.
 *   • Outbound → sent directly from Next.js with `messages.send`.
 *
 * Unlike MAX, VK's webhook (Callback API) is fully self-serviceable over the
 * API: we fetch the confirmation code, register the callback server with a
 * secret, and switch on the `message_new` event — no manual dashboard setup.
 */

const VK_API_BASE = process.env.VK_API_BASE || 'https://api.vk.com/method'
const VK_API_VERSION = process.env.VK_API_VERSION || '5.199'

/** A VK community as returned by groups.getById. */
export interface VkGroup {
  id: number
  name?: string
  screen_name?: string
}

/** A VK user as returned by users.get. */
export interface VkUser {
  id: number
  first_name?: string
  last_name?: string
  screen_name?: string
}

/** The inbound message embedded in a `message_new` Callback event. */
export interface VkMessage {
  id?: number
  conversation_message_id?: number
  date?: number
  peer_id: number
  from_id: number
  text?: string
}

/** A VK Callback API update. We care primarily about `message_new`. */
export interface VkUpdate {
  type: string
  /** Present on `confirmation` and every event — identifies the community. */
  group_id?: number
  /** Secret key echoed by VK on every event once a callback secret is set. */
  secret?: string
  event_id?: string
  /**
   * For `message_new` (API 5.103+) this is `{ message, client_info }`. For the
   * legacy format it was the message object directly — we normalise both.
   */
  object?: {
    message?: VkMessage
    client_info?: unknown
  } & Partial<VkMessage>
}

export type VkResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: number }

/** VK's uniform JSON envelope: either `{ response }` or `{ error }`. */
interface VkEnvelope<T> {
  response?: T
  error?: { error_code?: number; error_msg?: string }
}

/**
 * Call a VK API method. Params (including the access token + version) are sent
 * as an `application/x-www-form-urlencoded` POST body so long message text never
 * blows the URL length limit.
 */
async function call<T>(
  method: string,
  token: string,
  params: Record<string, string | number> = {},
): Promise<VkResult<T>> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) body.set(k, String(v))
  body.set('access_token', token)
  body.set('v', VK_API_VERSION)

  try {
    const res = await fetch(`${VK_API_BASE}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    })
    const text = await res.text()
    let parsed: VkEnvelope<T> | null = null
    try {
      parsed = text ? (JSON.parse(text) as VkEnvelope<T>) : null
    } catch {
      // non-JSON body
    }
    if (parsed?.error) {
      return {
        ok: false,
        error: parsed.error.error_msg || `VK API error`,
        code: parsed.error.error_code,
      }
    }
    if (!res.ok) {
      return { ok: false, error: `VK API HTTP ${res.status}`, code: res.status }
    }
    return { ok: true, data: (parsed?.response ?? {}) as T }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'network error',
    }
  }
}

/**
 * Resolve the community that owns this token. With a community access token,
 * groups.getById returns that community when no group_ids are passed. Used at
 * connect time to validate the token before we persist the channel.
 */
export async function getGroup(token: string): Promise<VkResult<VkGroup>> {
  const res = await call<VkGroup[] | { groups?: VkGroup[] }>(
    'groups.getById',
    token,
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

/** Fetch the Callback API confirmation string VK expects us to echo back. */
export async function getConfirmationCode(
  token: string,
  groupId: number,
): Promise<VkResult<string>> {
  const res = await call<{ code?: string }>(
    'groups.getCallbackConfirmationCode',
    token,
    { group_id: groupId },
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
  title = 'Inbox',
): Promise<VkResult<{ server_id: number }>> {
  return call<{ server_id: number }>('groups.addCallbackServer', token, {
    group_id: groupId,
    url,
    title,
    secret_key: secret,
  })
}

/** Switch on the `message_new` event for a registered callback server. */
export async function setCallbackSettings(
  token: string,
  groupId: number,
  serverId: number,
): Promise<VkResult<number>> {
  return call<number>('groups.setCallbackSettings', token, {
    group_id: groupId,
    server_id: serverId,
    api_version: VK_API_VERSION,
    message_new: 1,
  })
}

/** Remove a previously-registered callback server (best-effort cleanup). */
export async function deleteCallbackServer(
  token: string,
  groupId: number,
  serverId: number,
): Promise<VkResult<number>> {
  return call<number>('groups.deleteCallbackServer', token, {
    group_id: groupId,
    server_id: serverId,
  })
}

/**
 * Send a text message to a VK user. Addressed by peer_id (== the user's id for
 * direct dialogs, which is what we store as the contact handle). `random_id`
 * dedupes retries on VK's side. Returns the provider message id on success.
 */
export async function sendMessage(
  token: string,
  peerId: string | number,
  text: string,
): Promise<VkResult<{ messageId: string | null }>> {
  const res = await call<number>('messages.send', token, {
    peer_id: peerId,
    message: text,
    random_id: Math.floor(Math.random() * 2_000_000_000),
  })
  if (!res.ok) return res
  return { ok: true, data: { messageId: res.data ? String(res.data) : null } }
}

/** Look up a single user's profile so inbound conversations get a real name. */
export async function getUser(
  token: string,
  userId: string | number,
): Promise<VkResult<VkUser | null>> {
  const res = await call<VkUser[]>('users.get', token, {
    user_ids: userId,
    fields: 'screen_name',
  })
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
