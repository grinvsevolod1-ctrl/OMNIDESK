import type { Message } from '@/lib/types'

/**
 * LEGACY reply convention. Older god-messenger builds embedded the quoted
 * message as a readable `[В ответ: "…"]` prefix inside the body. New messages
 * use the REAL `reply_to_message_id` column (see secretSendMessageAction), so
 * this parser exists only to keep historical messages rendering correctly.
 */
const REPLY_RE = /^\[В ответ: "([\s\S]*?)"\]\n([\s\S]*)$/

export function parseReply(body: string): { quote: string | null; text: string } {
  const m = body.match(REPLY_RE)
  if (!m) return { quote: null, text: body }
  return { quote: m[1], text: m[2] }
}

/**
 * Short one-line preview of a message, used in the reply banner and quote
 * blocks. Preserves the original characters (including quotes) — it only
 * collapses whitespace and truncates.
 */
export function snippetOf(message: Message): string {
  if (message.deletedAt) return 'Удалённое сообщение'
  if (message.mediaType) {
    const label =
      message.mediaType === 'image'
        ? 'Фото'
        : message.mediaType === 'video'
          ? 'Видео'
          : message.mediaType === 'voice'
            ? 'Голосовое сообщение'
            : message.mediaType === 'audio'
              ? 'Аудио'
              : message.mediaType === 'sticker'
                ? 'Стикер'
                : 'Файл'
    const text = parseReply(message.body || '').text.trim()
    return text && !text.startsWith('[') ? `${label} · ${text}`.slice(0, 90) : label
  }
  const base = parseReply(message.body || '').text
  return base.replace(/\s+/g, ' ').trim().slice(0, 90)
}
