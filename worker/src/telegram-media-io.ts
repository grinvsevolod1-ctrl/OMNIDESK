import { TelegramClient, Api } from 'telegram'
import { returnBigInt } from 'telegram/Helpers.js'
import { logger } from './logger.js'
import * as repo from './repo.js'
import { classifyTgMedia } from './telegram-media.js'
import { MEDIA_MAX_STORE_BYTES, TG_STORE_MEDIA } from './telegram-config.js'
import type { TgSessionCtx } from './telegram-session-ctx.js'

/**
 * Media byte persistence + sticker IO for one Telegram session. Extracted
 * verbatim from the TelegramSession monolith. Everything here is best-effort:
 * a failed download must never break ingest or a job runner.
 */

/**
 * Download the media bytes straight from a message we already hold (live event
 * or backfill page) and persist them in Postgres, so the file survives the
 * contact later deleting/editing the original. Best-effort and idempotent: it
 * skips when storage is off, the message already has stored bytes, the file is
 * over the size cap, or the download fails. Never throws into ingest.
 */
export async function persistMediaBytes(
  client: TelegramClient | null,
  messageId: string | null,
  msg: Api.Message,
): Promise<void> {
  if (!messageId || !TG_STORE_MEDIA || !client) return
  if (!msg.media) return
  try {
    if (!(await repo.messageNeedsMediaBytes(messageId))) return
    const buf = (await client.downloadMedia(msg)) as Buffer | undefined
    if (!buf || !buf.length) return
    if (buf.byteLength > MEDIA_MAX_STORE_BYTES) return
    const info = classifyTgMedia(msg)
    await repo.storeMessageMediaBytes(
      messageId,
      Buffer.from(buf),
      info?.mediaMime ?? null,
      info?.mediaName ?? null,
    )
  } catch (err) {
    logger.warn({ err, messageId }, 'telegram media persist failed')
  }
}

/**
 * Re-download the media bytes for a previously ingested message. `ref` is the
 * descriptor we stored at ingest time ({ peer, msgId }). Returns the raw
 * buffer plus a best-effort MIME/name, or null if the message/media is gone.
 */
export async function downloadMediaByRef(
  ctx: TgSessionCtx,
  ref: unknown,
): Promise<{ buffer: Buffer; mime: string | null; name: string | null } | null> {
  const client = ctx.getClient()
  if (!client) throw new Error('Session not started')
  const r = ref as { peer?: string; msgId?: string } | null
  if (!r || !r.peer || !r.msgId) return null

  const entity = await ctx.resolveTarget(r.peer)
  const messages = await client.getMessages(entity, {
    ids: [Number(r.msgId)],
  })
  const message = messages?.[0]
  if (!message || !message.media) return null

  const info = classifyTgMedia(message)
  const buf = (await client.downloadMedia(message)) as Buffer | undefined
  if (!buf) return null
  return {
    buffer: Buffer.from(buf),
    mime: info?.mediaMime ?? null,
    name: info?.mediaName ?? null,
  }
}

/** Compact sticker descriptor the panel can render and later send back. */
export interface StickerDescriptor {
  id: string
  accessHash: string
  fileReference: string
  emoji: string
  mime: string
}

/**
 * List stickers available to this account: recent + favourited. Returns a
 * compact descriptor the panel can render and later send back.
 */
export async function listStickers(
  client: TelegramClient | null,
): Promise<StickerDescriptor[]> {
  if (!client) throw new Error('Session not started')
  const out: StickerDescriptor[] = []
  const seen = new Set<string>()

  const pushDoc = (doc: Api.TypeDocument, emoji: string) => {
    if (!(doc instanceof Api.Document)) return
    const id = String(doc.id)
    if (seen.has(id)) return
    seen.add(id)
    out.push({
      id,
      accessHash: String(doc.accessHash),
      fileReference: Buffer.from(doc.fileReference).toString('base64'),
      emoji,
      mime: doc.mimeType || 'image/webp',
    })
  }

  const emojiOf = (doc: Api.TypeDocument): string => {
    if (!(doc instanceof Api.Document)) return ''
    for (const a of doc.attributes) {
      if (a instanceof Api.DocumentAttributeSticker) return a.alt || ''
    }
    return ''
  }

  // Favourited stickers first.
  try {
    const fav = await client.invoke(
      new Api.messages.GetFavedStickers({ hash: returnBigInt(0) }),
    )
    if (fav instanceof Api.messages.FavedStickers) {
      for (const d of fav.stickers) pushDoc(d, emojiOf(d))
    }
  } catch (err) {
    logger.warn({ err }, 'telegram getFavedStickers failed')
  }

  // Then recently used.
  try {
    const recent = await client.invoke(
      new Api.messages.GetRecentStickers({ hash: returnBigInt(0) }),
    )
    if (recent instanceof Api.messages.RecentStickers) {
      for (const d of recent.stickers) pushDoc(d, emojiOf(d))
    }
  } catch (err) {
    logger.warn({ err }, 'telegram getRecentStickers failed')
  }

  return out
}

/** Download a sticker's bytes by its document descriptor (for thumbnails). */
export async function downloadStickerById(
  client: TelegramClient | null,
  sticker: { id: string; accessHash: string; fileReference: string },
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!client) throw new Error('Session not started')
  const location = new Api.InputDocumentFileLocation({
    id: returnBigInt(sticker.id),
    accessHash: returnBigInt(sticker.accessHash),
    fileReference: Buffer.from(sticker.fileReference, 'base64'),
    thumbSize: '',
  })
  const buf = (await client.downloadFile(location, {})) as
    | Buffer
    | undefined
  if (!buf || buf.length === 0) return null
  return { buffer: Buffer.from(buf), mime: 'image/webp' }
}

/**
 * Send a sticker by its document descriptor (id/accessHash/fileReference).
 * Telegram-only. Shares the same per-account throttle as text sends.
 */
export async function sendStickerTo(
  ctx: TgSessionCtx,
  target: string,
  sticker: { id: string; accessHash: string; fileReference: string },
): Promise<void> {
  const client = ctx.getClient()
  if (!client) throw new Error('Session not started')
  await ctx.throttleSend()
  const entity = await ctx.resolveTarget(target)
  const inputDoc = new Api.InputDocument({
    id: returnBigInt(sticker.id),
    accessHash: returnBigInt(sticker.accessHash),
    fileReference: Buffer.from(sticker.fileReference, 'base64'),
  })
  await client.sendMessage(entity, { file: inputDoc as never })
}
