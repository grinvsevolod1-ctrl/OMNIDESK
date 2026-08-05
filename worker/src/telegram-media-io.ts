import { TelegramClient, Api } from 'telegram'
import { CustomFile } from 'telegram/client/uploads.js'
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

/** Sniff a sticker payload's real container from its magic bytes. */
function sniffStickerMime(buf: Buffer): string {
  // Gzip magic — TGS (gzipped Lottie JSON animation).
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b)
    return 'application/x-tgsticker'
  // EBML magic — WEBM video sticker.
  if (
    buf.length > 4 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  )
    return 'video/webm'
  return 'image/webp'
}

/**
 * Download a sticker's bytes by its document descriptor (for picker
 * thumbnails). Static stickers are WEBP and render in an <img> as-is — but
 * animated (TGS) and video (WEBM) stickers do NOT: serving their full payload
 * labeled image/webp is exactly why picker thumbnails showed broken images.
 * For those, fall back to the document's static preview (thumbSize 'm').
 */
export async function downloadStickerById(
  client: TelegramClient | null,
  sticker: { id: string; accessHash: string; fileReference: string },
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!client) throw new Error('Session not started')
  const loc = (thumbSize: string) =>
    new Api.InputDocumentFileLocation({
      id: returnBigInt(sticker.id),
      accessHash: returnBigInt(sticker.accessHash),
      fileReference: Buffer.from(sticker.fileReference, 'base64'),
      thumbSize,
    })
  const buf = (await client.downloadFile(loc(''), {})) as Buffer | undefined
  if (!buf || buf.length === 0) return null
  const mime = sniffStickerMime(buf)
  if (mime === 'image/webp') return { buffer: Buffer.from(buf), mime }
  // Animated/video sticker: an <img> can't show the full payload. Grab the
  // static preview instead; if the document has none, serve the real bytes
  // with an honest mime so the client can still decide what to do.
  try {
    const thumb = (await client.downloadFile(loc('m'), {})) as
      | Buffer
      | undefined
    if (thumb && thumb.length > 0) {
      return { buffer: Buffer.from(thumb), mime: 'image/jpeg' }
    }
  } catch (err) {
    logger.warn({ err }, 'telegram sticker static thumb download failed')
  }
  return { buffer: Buffer.from(buf), mime }
}

/**
 * Send a voice note recorded in the panel composer. The buffer is OGG/Opus
 * (MediaRecorder output transcoded panel-side or raw when the browser already
 * records opus). `voiceNote: true` makes Telegram render it as a proper voice
 * bubble with waveform, not a file attachment. Shares the per-account send
 * throttle. Returns the provider message id for read-receipt tracking.
 */
export async function sendVoiceTo(
  ctx: TgSessionCtx,
  target: string,
  audio: { buffer: Buffer; durationSec: number },
): Promise<{ providerMessageId: string | null }> {
  const client = ctx.getClient()
  if (!client) throw new Error('Session not started')
  await ctx.throttleSend()
  const entity = await ctx.resolveTarget(target)
  const file = new CustomFile('voice.ogg', audio.buffer.byteLength, '', audio.buffer)
  const sent = await client.sendFile(entity, {
    file,
    voiceNote: true,
    attributes: [
      new Api.DocumentAttributeAudio({
        voice: true,
        duration: Math.max(1, Math.round(audio.durationSec)),
      }),
    ],
  })
  return { providerMessageId: sent?.id != null ? String(sent.id) : null }
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
