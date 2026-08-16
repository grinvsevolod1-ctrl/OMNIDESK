import 'server-only'
import { proxiedFetch, type ProxyDescriptor } from './proxy-agent'

/**
 * VK API core: shared types, the uniform result envelope, error translation
 * and the low-level `vkCall` transport. Extracted from vk.ts so the API
 * methods (vk.ts) and the media upload/parse helpers (vk-media.ts) can share
 * one transport without a circular import. App code should keep importing
 * from '@/lib/vk', which re-exports everything public.
 */

const VK_API_BASE = process.env.VK_API_BASE || 'https://api.vk.com/method'
export const VK_API_VERSION = process.env.VK_API_VERSION || '5.199'

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
  photo_100?: string
  online?: number
}

/** The inbound message embedded in a `message_new` Callback event. */
export interface VkMessage {
  id?: number
  conversation_message_id?: number
  date?: number
  peer_id: number
  from_id: number
  text?: string
  attachments?: VkAttachment[]
}

/** A VK message attachment (we surface photos/docs/audio/video/stickers). */
export interface VkAttachment {
  type: string
  photo?: { sizes?: { type?: string; url?: string; width?: number }[] }
  doc?: {
    title?: string
    ext?: string
    url?: string
    /** Present for image/video preview docs (gifs etc.). */
    preview?: { photo?: { sizes?: { src?: string; url?: string; width?: number }[] } }
  }
  audio_message?: { link_mp3?: string; link_ogg?: string; duration?: number }
  audio?: { artist?: string; title?: string; url?: string }
  video?: { title?: string; duration?: number }
  sticker?: { images?: { url?: string; width?: number }[]; sticker_id?: number }
  wall?: unknown
  link?: { url?: string; title?: string }
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
 * Translate a raw VK API error into a short, human-readable Russian reason so
 * the panel can tell the manager exactly WHY a send failed (instead of a bare
 * "!"). Falls back to VK's own message when the code is unmapped.
 *
 * Reference: https://dev.vk.com/reference/errors
 */
export function vkErrorText(code: number | undefined, fallback: string): string {
  switch (code) {
    case 5:
      return 'Токен сообщества недействителен или отозван. Переподключите аккаунт.'
    case 6:
      return 'Слишком много запросов к VK — попробуйте отправить чуть позже.'
    case 7:
    case 15:
      return 'Нет прав на отправку сообщений (проверьте scope «Сообщения» и «Управление» у токена).'
    case 9:
      return 'VK временно ограничил отправку (flood control). Повторите позже.'
    case 900:
      return 'Нельзя написать пользователю: он занёс сообщество в чёрный список.'
    case 901:
      return 'Пользователь запретил сообщения от сообщества (не разрешил переписку).'
    case 902:
      return 'Нельзя написать этому пользователю из-за его настроек приватности.'
    case 913:
      return 'Слишком много пересланных сообщений.'
    case 914:
      return 'Сообщение слишком длинное.'
    case 917:
      return 'Нет доступа к этому диалогу.'
    case 925:
      return 'Требуются права администратора беседы.'
    case 936:
      return 'Получатель недоступен: диалог удалён или пользователь заблокирован.'
    case 945:
      return 'Беседа отключена — отправка недоступна.'
    default:
      return fallback || 'VK отклонил отправку сообщения.'
  }
}

/**
 * Call a VK API method through the account's proxy. Params (including the access
 * token + version) are sent as an `application/x-www-form-urlencoded` POST body
 * so long message text never blows the URL length limit.
 */
export async function vkCall<T>(
  method: string,
  token: string,
  params: Record<string, string | number> = {},
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<T>> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) body.set(k, String(v))
  body.set('access_token', token)
  body.set('v', VK_API_VERSION)

  try {
    const res = await proxiedFetch(
      `${VK_API_BASE}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        cache: 'no-store',
      },
      proxy,
    )
    const text = await res.text()
    let parsed: VkEnvelope<T> | null = null
    try {
      parsed = text ? (JSON.parse(text) as VkEnvelope<T>) : null
    } catch {
      // non-JSON body
    }
    if (parsed?.error) {
      const code = parsed.error.error_code
      return {
        ok: false,
        error: vkErrorText(code, parsed.error.error_msg || 'VK API error'),
        code,
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
