import 'server-only'
import { proxiedFetch, type ProxyDescriptor } from './proxy-agent'

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
async function call<T>(
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

/** A saved/sent attachment: the `attachment` param for messages.send plus an
 * optional CDN url so the panel can re-display the media it just sent. */
export interface VkUploadedAttachment {
  attachment: string
  url: string | null
}

/** Pick the widest available size URL from a VK photo `sizes` array. */
function largestPhotoUrl(
  sizes: { url?: string; width?: number }[] | undefined,
): string | null {
  if (!sizes?.length) return null
  let best: { url?: string; width?: number } | null = null
  for (const s of sizes) {
    if (!s.url) continue
    if (!best || (s.width ?? 0) > (best.width ?? 0)) best = s
  }
  return best?.url ?? null
}

/**
 * Upload a photo into a dialog and return the attachment descriptor
 * (`photo{owner}_{id}`) usable by sendMessage, plus a CDN url for display.
 * Three-step VK flow: get an upload server, POST the bytes, then save. All hops
 * go through the account's proxy.
 */
export async function uploadPhotoAttachment(
  token: string,
  peerId: string | number,
  bytes: Blob,
  filename: string,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<VkUploadedAttachment>> {
  const server = await call<{ upload_url?: string }>(
    'photos.getMessagesUploadServer',
    token,
    { peer_id: peerId },
    proxy,
  )
  if (!server.ok) return server
  if (!server.data.upload_url) {
    return { ok: false, error: 'VK не вернул адрес загрузки фото.' }
  }

  let uploaded: { server?: number; photo?: string; hash?: string }
  try {
    const form = new FormData()
    form.append('photo', bytes, filename || 'photo.jpg')
    const up = await proxiedFetch(
      server.data.upload_url,
      { method: 'POST', body: form, cache: 'no-store' },
      proxy,
    )
    uploaded = (await up.json()) as typeof uploaded
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Не удалось загрузить фото в VK.',
    }
  }
  if (!uploaded.photo || uploaded.server == null || !uploaded.hash) {
    return { ok: false, error: 'VK вернул некорректный ответ при загрузке фото.' }
  }

  const saved = await call<
    { owner_id: number; id: number; sizes?: { url?: string; width?: number }[] }[]
  >(
    'photos.saveMessagesPhoto',
    token,
    {
      photo: uploaded.photo,
      server: uploaded.server,
      hash: uploaded.hash,
    },
    proxy,
  )
  if (!saved.ok) return saved
  const p = saved.data[0]
  if (!p) return { ok: false, error: 'VK не сохранил загруженное фото.' }
  return {
    ok: true,
    data: { attachment: `photo${p.owner_id}_${p.id}`, url: largestPhotoUrl(p.sizes) },
  }
}

/**
 * Upload a document (any non-image file) into a dialog and return the attachment
 * descriptor (`doc{owner}_{id}`) usable by sendMessage. Same three-step VK flow
 * as photos but via docs.getMessagesUploadServer / docs.save. All hops go
 * through the account's proxy.
 */
export async function uploadDocAttachment(
  token: string,
  peerId: string | number,
  bytes: Blob,
  filename: string,
  proxy?: ProxyDescriptor | null,
): Promise<VkResult<VkUploadedAttachment>> {
  const server = await call<{ upload_url?: string }>(
    'docs.getMessagesUploadServer',
    token,
    { peer_id: peerId, type: 'doc' },
    proxy,
  )
  if (!server.ok) return server
  if (!server.data.upload_url) {
    return { ok: false, error: 'VK не вернул адрес загрузки файла.' }
  }

  let uploaded: { file?: string }
  try {
    const form = new FormData()
    form.append('file', bytes, filename || 'file')
    const up = await proxiedFetch(
      server.data.upload_url,
      { method: 'POST', body: form, cache: 'no-store' },
      proxy,
    )
    uploaded = (await up.json()) as typeof uploaded
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Не удалось загрузить файл в VK.',
    }
  }
  if (!uploaded.file) {
    return { ok: false, error: 'VK вернул некорректный ответ при загрузке файла.' }
  }

  const saved = await call<{
    type?: string
    doc?: { id?: number; owner_id?: number; url?: string }
  }>(
    'docs.save',
    token,
    { file: uploaded.file, title: filename || 'file' },
    proxy,
  )
  if (!saved.ok) return saved
  const node = saved.data.doc
  if (!node?.id || node.owner_id == null) {
    return { ok: false, error: 'VK не сохранил загруженный файл.' }
  }
  return {
    ok: true,
    data: { attachment: `doc${node.owner_id}_${node.id}`, url: node.url ?? null },
  }
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

/** Parsed media descriptor for an inbound VK attachment. */
export interface ParsedVkMedia {
  /** Conversation-list preview label when the message has no text. */
  preview: string
  mediaType: 'image' | 'voice' | 'audio' | 'document' | 'sticker' | null
  mediaMime: string | null
  mediaName: string | null
  /** `{ url }` streamed by the media proxy; null for kinds we can't download. */
  mediaRef: { url: string } | null
}

/** Pick the widest url from a VK sizes array (handles both `url` and `src`). */
function widestUrl(
  sizes: { url?: string; src?: string; width?: number }[] | undefined,
): string | null {
  if (!sizes?.length) return null
  let best: { url?: string; src?: string; width?: number } | null = null
  for (const s of sizes) {
    if (!s.url && !s.src) continue
    if (!best || (s.width ?? 0) > (best.width ?? 0)) best = s
  }
  return best?.url ?? best?.src ?? null
}

/**
 * Turn a VK message's attachments into a single media descriptor for the inbox.
 * VK messages can carry several attachments; we surface the FIRST downloadable
 * one (photo/doc/voice/audio/sticker) and fall back to a text placeholder for
 * kinds we can't stream (video/wall/link/…). Returns null when there is nothing
 * to show.
 */
export function parseVkAttachments(
  attachments: VkAttachment[] | undefined,
): ParsedVkMedia | null {
  if (!attachments?.length) return null

  for (const a of attachments) {
    switch (a.type) {
      case 'photo': {
        const url = widestUrl(a.photo?.sizes)
        if (url)
          return { preview: '[Фото]', mediaType: 'image', mediaMime: 'image/jpeg', mediaName: null, mediaRef: { url } }
        break
      }
      case 'sticker': {
        const url = widestUrl(a.sticker?.images)
        if (url)
          return { preview: '[Стикер]', mediaType: 'sticker', mediaMime: 'image/png', mediaName: null, mediaRef: { url } }
        break
      }
      case 'audio_message': {
        const url = a.audio_message?.link_mp3 || a.audio_message?.link_ogg
        if (url) {
          const mime = a.audio_message?.link_mp3 ? 'audio/mpeg' : 'audio/ogg'
          return { preview: '[Голосовое сообщение]', mediaType: 'voice', mediaMime: mime, mediaName: null, mediaRef: { url } }
        }
        break
      }
      case 'doc': {
        const url = a.doc?.url
        const name = a.doc?.title
          ? a.doc.ext && !a.doc.title.endsWith(`.${a.doc.ext}`)
            ? `${a.doc.title}.${a.doc.ext}`
            : a.doc.title
          : null
        if (url)
          return { preview: name ? `[Документ: ${name}]` : '[Документ]', mediaType: 'document', mediaMime: null, mediaName: name, mediaRef: { url } }
        break
      }
      case 'audio': {
        const title = [a.audio?.artist, a.audio?.title].filter(Boolean).join(' — ')
        if (a.audio?.url)
          return { preview: title ? `[Аудио: ${title}]` : '[Аудио]', mediaType: 'audio', mediaMime: 'audio/mpeg', mediaName: title || null, mediaRef: { url: a.audio.url } }
        return { preview: title ? `[Аудио: ${title}]` : '[Аудио]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
      }
      case 'video':
        return { preview: a.video?.title ? `[Видео: ${a.video.title}]` : '[Видео]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
      case 'link':
        return { preview: a.link?.title ? `[Ссылка: ${a.link.title}]` : '[Ссылка]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
      case 'wall':
        return { preview: '[Запись со стены]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
      default:
        break
    }
  }
  // Unknown/undownloadable attachment(s): show a generic placeholder.
  return { preview: '[Вложение]', mediaType: null, mediaMime: null, mediaName: null, mediaRef: null }
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
