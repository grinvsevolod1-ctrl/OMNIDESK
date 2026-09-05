export type MessageDirection = 'in' | 'out'

/**
 * Delivery lifecycle of an OUTBOUND message, mirroring messenger ticks:
 *   pending   -> queued locally, not yet acked      (clock)
 *   sent      -> accepted by the provider          (single ✓)
 *   delivered -> reached the contact's device      (double ✓, grey)
 *   read      -> the contact opened/read it         (double ✓, blue)
 *   failed    -> the provider rejected the send     (! warning)
 * Inbound messages have no status (undefined).
 */
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

/** Kinds of media a message can carry (mirrors the DB check constraint). */
export type MediaType =
  | 'image'
  | 'video'
  | 'video_note'
  | 'audio'
  | 'voice'
  | 'sticker'
  | 'document'

export interface Message {
  id: string
  conversationId: string
  direction: MessageDirection
  body: string
  author: string
  createdAt: string
  /** Present when the message carries media (incoming or outgoing sticker). */
  mediaType?: MediaType
  /** MIME type of the media, when known. */
  mediaMime?: string
  /** Original file name, for documents. */
  mediaName?: string
  /**
   * Panel URL to stream the media bytes (`/api/media/{id}`). The worker
   * re-downloads from the provider on demand; nothing binary is stored in the
   * database.
   */
  mediaUrl?: string
  /** Quoted reply preview, when this message replies to another. */
  replyTo?: MessageReplyPreview
  /** Emoji reactions on this message. */
  reactions?: MessageReaction[]
  /**
   * Set when the message was deleted (soft-delete). The original content is
   * preserved; the UI renders it with a "deleted" marker rather than dropping
   * the row.
   */
  deletedAt?: string
  /** Who deleted the message: 'self' = operator, 'remote' = the contact. */
  deletedOrigin?: 'self' | 'remote'
  /**
   * Set when the message was edited (by the contact or from a linked device).
   * The live body/media always reflect the latest version; the full before/after
   * trail is available on demand from `/api/messages/{id}/edits`.
   */
  editedAt?: string
  /** How many times the message has been edited (>= 1 when edited). */
  editCount?: number
  /** Delivery/read status for outbound messages (undefined for inbound). */
  status?: MessageStatus
  /**
   * Client-only (god messenger). Groups several media messages that were sent
   * together into one Telegram-style album grid. Never persisted server-side.
   */
  albumId?: string
  /**
   * Client-only. Local object URL shown INSTANTLY while the file uploads, so a
   * photo appears in the thread before the server round-trip finishes and never
   * triggers an `/api/media` fetch during the session.
   */
  localPreviewUrl?: string
  /** Client-only. Media is still uploading (progress ring, no lightbox link). */
  uploading?: boolean
  /** Client-only. Upload progress in [0,1] when the transport reports it. */
  uploadProgress?: number
  /**
   * Human-readable reason a send failed (only set when status === 'failed'),
   * e.g. "Пользователь запретил сообщения от сообщества" (VK) or "Окно 24 часов
   * закрыто" (WhatsApp). Shown in the inbox next to the failed marker.
   */
  errorReason?: string
}

/**
 * One historical version of an edited message, oldest-first. `version` 1 is the
 * original as first received; the message's live row holds the current text.
 */
export interface MessageEdit {
  id: string
  version: number
  body: string
  mediaType?: MediaType
  /** Panel URL to stream this version's archived media, if it had any. */
  mediaUrl?: string
  /** When this version was superseded by the next edit. */
  recordedAt: string
}

/** Compact preview of a quoted (replied-to) message. */
export interface MessageReplyPreview {
  id: string
  author: string
  /** Short text/snippet of the quoted message. */
  body: string
  /** Media kind of the quoted message, if it was media. */
  mediaType?: MediaType
}

/** A single emoji reaction on a message. */
export interface MessageReaction {
  emoji: string
  /** True when the reaction was added by the operator (this account). */
  fromMe: boolean
}

/** A sticker offered to the composer, fetched live from the worker. */
export interface StickerItem {
  /** Telegram document id (string to survive JSON / bigint). */
  id: string
  /** Document access hash (string form). */
  accessHash: string
  /** File reference bytes, base64-encoded. */
  fileReference: string
  /** Associated emoji, if any. */
  emoji: string
  /** MIME type of the sticker file (image/webp, video/webm, …). */
  mime: string
}

/**
 * A manager's personal canned response. Shown as one-tap chips above the inbox
 * composer so prepared answers can be inserted into the draft instantly.
 */
export interface QuickReply {
  id: string
  title: string
  body: string
  sortOrder: number
  createdAt: string
}
