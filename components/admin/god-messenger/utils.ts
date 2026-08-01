import type { KeyboardEvent } from 'react'

/**
 * Shared label map, date/name formatters and the IME-composition guard used by
 * the god messenger and its new-chat dialog. Pure and presentational — kept in
 * one place so the list, thread and dialog stay in sync.
 */

/** Human-readable channel-type labels shown on conversation rows and pickers. */
export const TYPE_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

/** Two-letter avatar initials derived from a contact/manager name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Short HH:MM time label; empty string for an unparseable date. */
export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

/** Day + time label used as the thread date divider. */
export function fmtDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** True while a CJK IME is composing (Safari reports keyCode 229). */
export function isComposing(e: KeyboardEvent): boolean {
  return (
    e.nativeEvent.isComposing ||
    (e as unknown as { keyCode: number }).keyCode === 229
  )
}
