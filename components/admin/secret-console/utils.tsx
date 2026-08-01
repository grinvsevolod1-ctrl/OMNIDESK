'use client'

/**
 * Shared constants, label/style maps, formatters and the search-highlight
 * helper for the god-console (secret-console). Pure and presentational —
 * extracted from the secret-console monolith so the root component and its
 * thread/dialog sub-parts can share them without duplication.
 */

/* ------------------------------- Labels ------------------------------- */

export const TYPE_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

/** God-console attachment chip labels (admin-only preview of what was sent). */
export const MEDIA_CHIP_LABEL: Record<string, string> = {
  image: 'Фото',
  video: 'Видео',
  video_note: 'Кружочек',
  audio: 'Аудио',
  document: 'Документ',
}

export const CONV_STATUS_LABEL: Record<string, string> = {
  liquid: 'Ликвид',
  not_liquid: 'Не ликвид',
  unsubscribed: 'Отписка',
  handoff: 'Передан человеку',
  transferred: 'Передан',
}

export const CONV_STATUS_STYLE: Record<string, string> = {
  liquid: 'bg-success/15 text-success',
  not_liquid: 'bg-warning/15 text-warning',
  unsubscribed: 'bg-muted text-muted-foreground',
  handoff: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  transferred: 'bg-chart-2/15 text-foreground',
}

export const STATUS_VALUES = [
  'unsubscribed',
  'handoff',
  'liquid',
  'not_liquid',
  'transferred',
]

/** Thread-level direction filter. */
export type DirFilter = 'all' | 'in' | 'out'

/* ------------------------------ Helpers ------------------------------- */

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

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

export function isComposing(e: React.KeyboardEvent): boolean {
  // Don't submit while a CJK IME is composing (Safari reports keyCode 229).
  return e.nativeEvent.isComposing || (e as unknown as { keyCode: number }).keyCode === 229
}

/** Split `text` on `query` (case-insensitive) and wrap matches in <mark>. */
export function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim()
  if (!q) return text
  const parts: React.ReactNode[] = []
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  let i = 0
  let key = 0
  while (i < text.length) {
    const at = lower.indexOf(needle, i)
    if (at === -1) {
      parts.push(text.slice(i))
      break
    }
    if (at > i) parts.push(text.slice(i, at))
    parts.push(
      <mark
        key={key++}
        className="rounded-sm bg-warning/40 px-0.5 text-inherit"
      >
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    i = at + needle.length
  }
  return parts
}
