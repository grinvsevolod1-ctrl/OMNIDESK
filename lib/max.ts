import 'server-only'
import { proxiedFetch, type ProxyDescriptor } from './proxy-agent'

/**
 * MAX Bot API client (https://dev.max.ru/docs-api).
 *
 * MAX exposes only a Bot API (no personal-account API). A bot is created via
 * @MasterBot, which issues a token. All requests go to https://botapi.max.ru
 * with the token passed as the `access_token` query parameter.
 *
 * Integration model in this app mirrors live-chat (NOT the Telegram/WhatsApp
 * worker): inbound arrives via a webhook registered with POST /subscriptions,
 * outbound is sent directly from Next.js with POST /messages. No persistent
 * socket, no worker, no anti-ban pacing — a bot only ever talks to users who
 * messaged it first.
 */

const MAX_API_BASE = process.env.MAX_API_BASE || 'https://botapi.max.ru'

/** A MAX user/bot identity as returned by /me and embedded in events. */
export interface MaxUser {
  user_id: number
  first_name?: string
  last_name?: string
  username?: string
  is_bot?: boolean
  name?: string
}

/** Result of GET /me — the bot's own identity. */
export interface MaxBotInfo {
  user_id: number
  first_name?: string
  username?: string
  name?: string
  description?: string
}

/** Recipient block on an inbound message event. */
export interface MaxRecipient {
  chat_id: number
  chat_type?: string
  user_id?: number
}

/** Body of an inbound message (text + provider message id). */
export interface MaxMessageBody {
  mid: string
  seq?: number
  text?: string | null
}

/** A MAX message object as embedded in webhook events. */
export interface MaxMessage {
  recipient: MaxRecipient
  sender: MaxUser
  timestamp?: number
  body: MaxMessageBody
}

/** A webhook update. We care primarily about `message_created`. */
export interface MaxUpdate {
  update_type: string
  timestamp?: number
  user_locale?: string
  message?: MaxMessage
  /** Present on bot_started / some callback updates. */
  user?: MaxUser
  chat_id?: number
  user_id?: number
}

/** Result of POST /messages. */
export interface MaxSendResult {
  message?: {
    body?: { mid?: string }
    recipient?: MaxRecipient
  }
}

export type MaxResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number }

function tokenUrl(path: string, token: string, params?: Record<string, string>) {
  const url = new URL(path, MAX_API_BASE)
  url.searchParams.set('access_token', token)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }
  return url.toString()
}

/**
 * Turn a raw MAX API failure into a short, human-readable Russian reason for the
 * panel. MAX returns `{ code, message }`; we map the common send failures and
 * fall back to the API's own message.
 */
export function maxErrorText(
  status: number | undefined,
  code: string | undefined,
  fallback: string,
): string {
  if (status === 401 || code === 'verify.token')
    return 'Токен бота MAX недействителен. Переподключите аккаунт.'
  if (status === 403 || code === 'access.denied')
    return 'Нет доступа: пользователь не начинал диалог с ботом или заблокировал его.'
  if (status === 404 || code === 'not.found')
    return 'Получатель не найден в MAX.'
  if (status === 429 || code === 'too.many.requests')
    return 'MAX ограничил частоту запросов — повторите позже.'
  if (status === 400 && /text/i.test(fallback))
    return 'MAX отклонил текст сообщения (проверьте длину/формат).'
  return fallback || 'MAX отклонил отправку сообщения.'
}

async function request<T>(
  url: string,
  init: RequestInit,
  proxy?: ProxyDescriptor | null,
): Promise<MaxResult<T>> {
  try {
    const res = await proxiedFetch(
      url,
      {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        // Always go to the network; never cache bot API calls.
        cache: 'no-store',
      },
      proxy,
    )
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        // non-JSON body
      }
    }
    if (!res.ok) {
      const api = parsed as { message?: string; code?: string } | null
      return {
        ok: false,
        error: maxErrorText(
          res.status,
          api?.code,
          api?.message || `MAX API error ${res.status}`,
        ),
        status: res.status,
      }
    }
    return { ok: true, data: (parsed ?? {}) as T }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'network error',
    }
  }
}

/**
 * Validate a bot token by fetching the bot's own identity. Used at connect time
 * to confirm the token is real before we persist the channel.
 */
export async function getMe(
  token: string,
  proxy?: ProxyDescriptor | null,
): Promise<MaxResult<MaxBotInfo>> {
  return request<MaxBotInfo>(tokenUrl('/me', token), { method: 'GET' }, proxy)
}

/**
 * Register (or replace) the webhook subscription for this bot. MAX will POST
 * every selected update type to `url`, including the `X-Max-Bot-Api-Secret`
 * header set to `secret` so we can verify the request really came from MAX.
 */
export async function subscribeWebhook(
  token: string,
  url: string,
  secret: string,
  updateTypes: string[] = ['message_created', 'bot_started'],
  proxy?: ProxyDescriptor | null,
): Promise<MaxResult<{ success?: boolean }>> {
  return request(
    tokenUrl('/subscriptions', token),
    {
      method: 'POST',
      body: JSON.stringify({ url, secret, update_types: updateTypes }),
    },
    proxy,
  )
}

/** Remove a previously-registered webhook subscription for this bot. */
export async function unsubscribeWebhook(
  token: string,
  url: string,
  proxy?: ProxyDescriptor | null,
): Promise<MaxResult<{ success?: boolean }>> {
  return request(
    tokenUrl('/subscriptions', token, { url }),
    { method: 'DELETE' },
    proxy,
  )
}

/**
 * Send a text message to a MAX user. The recipient is addressed by their numeric
 * user_id (what we store as the conversation contact handle). Returns the
 * provider message id (mid) on success so callers can persist it for receipts.
 */
export async function sendMessage(
  token: string,
  userId: string | number,
  text: string,
  proxy?: ProxyDescriptor | null,
): Promise<MaxResult<{ mid: string | null }>> {
  const res = await request<MaxSendResult>(
    tokenUrl('/messages', token, { user_id: String(userId) }),
    {
      method: 'POST',
      body: JSON.stringify({ text }),
    },
    proxy,
  )
  if (!res.ok) return res
  return { ok: true, data: { mid: res.data.message?.body?.mid ?? null } }
}

/** Human-readable display name for a MAX user, with sensible fallbacks. */
export function maxUserName(user: MaxUser | undefined): string {
  if (!user) return 'Пользователь MAX'
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return full || user.name || user.username || `MAX #${user.user_id}`
}
