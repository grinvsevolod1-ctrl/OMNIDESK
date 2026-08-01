import type { Message } from '@/lib/types'

/**
 * Client-side reply convention. Since the god send action only persists a plain
 * body (no reply column), a Telegram-style reply is embedded as a readable quote
 * prefix: the manager still sees the context, and this messenger parses it back
 * into a styled quote block. Kept intentionally simple and human-readable.
 */
const REPLY_RE = /^\[В ответ: "([\s\S]*?)"\]\n([\s\S]*)$/

export function parseReply(body: string): { quote: string | null; text: string } {
  const m = body.match(REPLY_RE)
  if (!m) return { quote: null, text: body }
  return { quote: m[1], text: m[2] }
}

export function snippetOf(message: Message): string {
  const base = parseReply(message.body || '').text
  return base.replace(/\s+/g, ' ').replace(/"/g, '').trim().slice(0, 90)
}

export function buildReplyBody(target: Message, text: string): string {
  return `[В ответ: "${snippetOf(target)}"]\n${text}`
}
