import { Api, type TelegramClient } from 'telegram'
import { CustomFile } from 'telegram/client/uploads.js'
import { returnBigInt } from 'telegram/Helpers.js'
import { logger } from './logger.js'
import { errMessage } from './telegram-errors.js'
import { classifyTgMedia } from './telegram-media.js'

/**
 * The god-panel "personal Telegram" feature: the owner drives their OWN
 * Telegram accounts as a plain messenger. This module is DELIBERATELY stateless
 * — nothing it reads or sends is ever written to Postgres. Dialogs and history
 * are pulled live from MTProto on demand, so no message content, contact list
 * or peer cache leaks onto the server (SACRED INVARIANT: maximal isolation and
 * privacy, see AGENTS.md §4).
 *
 * Contrast with the seller pipeline (telegram-history.ts / telegram-updates.ts),
 * which imports dialogs and ingests updates INTO the inbox. Personal sessions
 * skip all of that (see telegram-lifecycle.ts `personalMode`).
 */

/* --------------------------------- DTOs --------------------------------- */

export interface PersonalDialogDTO {
  /** Stringified peer id — used as the `target` for send/history calls. */
  peerId: string
  title: string
  username: string | null
  kind: 'user' | 'group' | 'channel'
  unreadCount: number
  /** Text or a media placeholder ("[Фото]") for the last message. */
  lastMessage: string
  /** Unix seconds of the last message, or null for an empty dialog. */
  lastMessageAt: number | null
  /** True when the last message was sent by us. */
  lastOutgoing: boolean
  /** Whether the peer has a profile photo (avatar endpoint is worth calling). */
  hasAvatar: boolean
  verified: boolean
}

export interface PersonalMessageDTO {
  /** Provider (Telegram) message id, as a string. */
  id: string
  outgoing: boolean
  text: string
  /** Unix seconds. */
  date: number
  mediaType:
    | 'image'
    | 'video'
    | 'video_note'
    | 'audio'
    | 'voice'
    | 'sticker'
    | 'document'
    | null
  mediaMime: string | null
  mediaName: string | null
  /** True only for our own plain-text messages (Telegram allows editing those). */
  editable: boolean
  /** Provider id of the message this one replies to, if any. */
  replyToId: string | null
}

/* ------------------------------- Resolver ------------------------------- */

/**
 * In-memory-only peer resolver for personal sessions. Unlike the seller
 * resolver (telegram-peers.ts) it NEVER touches the durable peer cache in
 * Postgres — reading or writing access_hashes there would leave a trace of the
 * owner's private contacts on the server. It relies on GramJS's in-process
 * entity cache, which `listPersonalDialogs` warms before any thread is opened;
 * a cold miss triggers one throttled getDialogs refresh and a getEntity
 * fallback, both purely in memory.
 */
export function createPersonalTargetResolver(
  getClient: () => TelegramClient | null,
): (target: string) => Promise<Api.TypeInputPeer | string> {
  let refreshedAt = 0
  return async function resolve(
    target: string,
  ): Promise<Api.TypeInputPeer | string> {
    if (target.startsWith('@')) return target
    const client = getClient()
    if (!client) throw new Error('Session not started')
    const peerId = returnBigInt(target)
    try {
      return await client.getInputEntity(peerId)
    } catch {
      // Cold in-memory cache (e.g. right after a worker restart, before the
      // dialog list has been fetched). Refresh once per minute, then retry.
      if (Date.now() - refreshedAt > 60_000) {
        refreshedAt = Date.now()
        try {
          await client.getDialogs({ limit: 100 })
        } catch (e) {
          logger.warn(
            { err: errMessage(e) },
            'personal: dialog refresh during resolve failed',
          )
        }
      }
      try {
        return await client.getInputEntity(peerId)
      } catch {
        const entity = await client.getEntity(peerId)
        return client.getInputEntity(entity)
      }
    }
  }
}

/* -------------------------------- Reads --------------------------------- */

function dialogKind(entity: unknown): 'user' | 'group' | 'channel' {
  if (entity instanceof Api.User) return 'user'
  if (entity instanceof Api.Channel) {
    return entity.megagroup ? 'group' : 'channel'
  }
  return 'group'
}

function lastMessageText(msg: Api.Message | undefined): string {
  if (!msg) return ''
  if (msg.message) return msg.message
  const media = classifyTgMedia(msg)
  return media?.placeholder ?? ''
}

/**
 * Live snapshot of the account's most recent dialogs. Pure read: warms the
 * in-memory entity cache as a side effect (which the resolver relies on) but
 * persists nothing.
 */
export async function listPersonalDialogs(
  client: TelegramClient,
  limit = 50,
): Promise<PersonalDialogDTO[]> {
  const dialogs = await client.getDialogs({ limit })
  const out: PersonalDialogDTO[] = []
  for (const dialog of dialogs) {
    const entity = dialog.entity as
      | Api.User
      | Api.Chat
      | Api.Channel
      | undefined
    if (!entity) continue
    const idAttr = (entity as { id?: unknown }).id
    if (idAttr == null) continue
    const title =
      dialog.title ||
      [
        (entity as Api.User).firstName,
        (entity as Api.User).lastName,
      ]
        .filter(Boolean)
        .join(' ') ||
      (entity as { username?: string }).username ||
      'Без имени'
    const msg = dialog.message as Api.Message | undefined
    out.push({
      peerId: String(idAttr),
      title,
      username: (entity as { username?: string }).username ?? null,
      kind: dialogKind(entity),
      unreadCount: dialog.unreadCount ?? 0,
      lastMessage: lastMessageText(msg),
      lastMessageAt: msg?.date ?? null,
      lastOutgoing: Boolean(msg?.out),
      hasAvatar: Boolean((entity as { photo?: unknown }).photo),
      verified: Boolean((entity as { verified?: boolean }).verified),
    })
  }
  return out
}

function toMessageDTO(msg: Api.Message): PersonalMessageDTO {
  const media = classifyTgMedia(msg)
  const replyToMsgId = (msg.replyTo as Api.MessageReplyHeader | undefined)
    ?.replyToMsgId
  return {
    id: String(msg.id),
    outgoing: Boolean(msg.out),
    text: msg.message ?? '',
    date: msg.date ?? 0,
    mediaType: media?.mediaType ?? null,
    mediaMime: media?.mediaMime ?? null,
    mediaName: media?.mediaName ?? null,
    // Telegram only allows editing the TEXT of your own messages, so media
    // bubbles and inbound messages are not editable.
    editable: Boolean(msg.out) && !media,
    replyToId: replyToMsgId != null ? String(replyToMsgId) : null,
  }
}

/**
 * Live history page for one dialog, oldest→newest. `beforeId` pages backwards
 * (older messages) for infinite scroll. Pure read: persists nothing.
 */
export async function getPersonalHistory(
  client: TelegramClient,
  resolveTarget: (target: string) => Promise<Api.TypeInputPeer | string>,
  peer: string,
  opts?: { beforeId?: number; limit?: number },
): Promise<PersonalMessageDTO[]> {
  const entity = await resolveTarget(peer)
  const messages = await client.getMessages(entity, {
    limit: opts?.limit ?? 40,
    ...(opts?.beforeId ? { maxId: opts.beforeId } : {}),
  })
  // getMessages returns newest-first; the UI renders oldest-first.
  return messages
    .filter((m): m is Api.Message => m instanceof Api.Message)
    .map(toMessageDTO)
    .reverse()
}

/**
 * Download a peer's profile photo (avatar). Returns null when the peer has no
 * photo. Pure read.
 */
export async function downloadPersonalAvatar(
  client: TelegramClient,
  resolveTarget: (target: string) => Promise<Api.TypeInputPeer | string>,
  peer: string,
): Promise<Buffer | null> {
  const entity = await resolveTarget(peer)
  try {
    const buf = (await client.downloadProfilePhoto(entity as never)) as
      | Buffer
      | undefined
    if (!buf || buf.byteLength === 0) return null
    return Buffer.from(buf)
  } catch (err) {
    logger.warn({ err: errMessage(err) }, 'personal: avatar download failed')
    return null
  }
}

/**
 * Live media download for one message in a personal thread (photo, voice,
 * video note, document …). Streams bytes straight to the caller — NOTHING is
 * persisted server-side, unlike the seller pipeline's persistMediaBytes which
 * writes into message_media. Returns null when the message has no media.
 */
export async function downloadPersonalMedia(
  client: TelegramClient,
  resolveTarget: (target: string) => Promise<Api.TypeInputPeer | string>,
  peer: string,
  messageId: number,
): Promise<{ buffer: Buffer; mime: string; name: string | null } | null> {
  const entity = await resolveTarget(peer)
  const [msg] = await client.getMessages(entity, { ids: [messageId] })
  if (!(msg instanceof Api.Message) || !msg.media) return null
  const info = classifyTgMedia(msg)
  if (!info) return null
  const buf = (await client.downloadMedia(msg)) as Buffer | undefined
  if (!buf || buf.byteLength === 0) return null
  return {
    buffer: Buffer.from(buf),
    mime: info.mediaMime ?? 'application/octet-stream',
    name: info.mediaName,
  }
}

/* -------------------------------- Sends --------------------------------- */

/**
 * Send a photo or document from the composer. `asPhoto` renders it as an inline
 * image bubble; otherwise it is delivered as a file attachment. Shares the
 * per-account send throttle via the caller (registry/session). Returns the new
 * provider message id.
 */
export async function sendPersonalFile(
  client: TelegramClient,
  entity: Api.TypeInputPeer | string,
  file: {
    buffer: Buffer
    name: string
    mime: string | null
    asPhoto: boolean
    caption?: string
    replyToMsgId?: number
  },
): Promise<{ providerMessageId: string | null }> {
  const custom = new CustomFile(
    file.name,
    file.buffer.byteLength,
    '',
    file.buffer,
  )
  const sent = await client.sendFile(entity, {
    file: custom,
    forceDocument: !file.asPhoto,
    caption: file.caption || undefined,
    replyTo: file.replyToMsgId,
  })
  return { providerMessageId: sent?.id != null ? String(sent.id) : null }
}
