import 'server-only'
import { proxiedFetch, type ProxyDescriptor } from './proxy-agent'

/**
 * MAX Bot API client (https://dev.max.ru/docs-api).
 *
 * MAX exposes only a Bot API (no personal-account API). A bot is created via
 * @MasterBot, which issues a token. All requests go to
 * https://botapi.max.ru with the token passed in the `Authorization` header as
 * a RAW string (no `Bearer ` prefix — adding it causes a 401).
 *
 * NOTE (domain choice): `botapi.max.ru` is the canonical Bot API host and is
 * reachable with a normally-trusted TLS chain. The alternative
 * `platform-api2.max.ru` host presents a certificate signed by the Russian
 * Минцифры root, which most hosts (incl. Vercel) do NOT trust — connecting
 * there fails at the TLS handshake and surfaces as a bare "fetch failed" before
 * any HTTP status. So we target botapi.max.ru. Override with `MAX_API_BASE`
 * only if you deploy on a host that trusts the Минцифры root.
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

/** A webhook update. We care about `message_created`, `message_edited` and
 *  `message_removed`. */
export interface MaxUpdate {
  update_type: string
  timestamp?: number
  user_locale?: string
  message?: MaxMessage
  /** Present on bot_started / some callback updates. */
  user?: MaxUser
  chat_id?: number
  user_id?: number
  /** Provider message id (mid) present on `message_removed` updates. */
  message_id?: string
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

/** Build an API URL. The token is NOT placed in the query string anymore — it
 *  travels in the Authorization header (see `request`). Only genuine query
 *  params (e.g. the `url` on DELETE /subscriptions, `user_id` on /messages) go
 *  here. */
function apiUrl(path: string, params?: Record<string, string>) {
  const url = new URL(path, MAX_API_BASE)
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
  token: string,
  init: RequestInit,
  proxy?: ProxyDescriptor | null,
): Promise<MaxResult<T>> {
  try {
    const res = await proxiedFetch(
      url,
      {
        ...init,
        headers: {
          'content-type': 'application/json',
          // MAX auth: raw token, NO "Bearer " prefix (Bearer → 401).
          Authorization: token,
          ...(init.headers ?? {}),
        },
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
    // A thrown error here is a transport failure (DNS/TLS/connection) — the
    // request never got an HTTP status back. The most common cause with MAX is
    // pointing MAX_API_BASE at platform-api2.max.ru, whose Минцифры-signed cert
    // isn't trusted, which fetch reports as a bare "fetch failed". Make that
    // actionable instead of showing it as if the token were bad.
    const raw = err instanceof Error ? err.message : 'network error'
    return {
      ok: false,
      error: `Не удалось соединиться с MAX API (${MAX_API_BASE}): ${raw}. Проверьте доступность домена и TLS-сертификат — по умолчанию используйте botapi.max.ru.`,
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
  return request<MaxBotInfo>(apiUrl('/me'), token, { method: 'GET' }, proxy)
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
    apiUrl('/subscriptions'),
    token,
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
    apiUrl('/subscriptions', { url }),
    token,
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
    apiUrl('/messages', { user_id: String(userId) }),
    token,
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
