/**
 * Pure helpers for the OS shell: the Web Speech API shim, the insights-mute
 * localStorage key, history-date formatting, and dock-section prompt text.
 * Split out of os-shell.tsx — no React, no side effects.
 */

import type { ShellSection } from '@/lib/admin-console/intents'

/** localStorage key: date when the admin muted proactive insights. */
export const INSIGHTS_MUTED_KEY = 'od-os:insights-muted'

/* ------------------------- Web Speech API shim ------------------------- */
/**
 * Minimal structural type for webkitSpeechRecognition — the DOM lib doesn't
 * ship it and we only need these members. Feature-detected at runtime; the
 * mic button simply doesn't render where the API is missing (Firefox).
 */
export interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>
      }) => void)
    | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
}

export function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (
    (w.SpeechRecognition as new () => SpeechRecognitionLike) ??
    (w.webkitSpeechRecognition as new () => SpeechRecognitionLike) ??
    null
  )
}

/** «сегодня, 14:05» / «3 мар., 09:12» for the history list. */
export function formatArchiveDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })
  return d.toDateString() === new Date().toDateString()
    ? `сегодня, ${time}`
    : `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${time}`
}

/** Natural-language prompt for a dock section click. */
export function sectionPrompt(id: ShellSection, title: string): string {
  switch (id) {
    case 'overview':
      return 'Покажи сводку системы'
    case 'managers':
      return 'Покажи список менеджеров'
    case 'accounts':
      return 'Покажи статусы всех аккаунтов'
    case 'finance':
      return 'Покажи финансовую сводку'
    case 'channels':
      return 'Покажи каналы'
    case 'proxies':
      return 'Покажи прокси'
    case 'contacts':
      return 'Покажи контакты по каналам'
    case 'hosting':
      return 'Покажи серверы'
    case 'ai':
      return 'Открой ИИ-менеджера'
    case 'dictionaries':
      return 'Покажи справочники'
    case 'whatsapp':
      return 'Открой раздел WhatsApp'
    case 'livechat':
      return 'Открой онлайн-чат'
    case 'telemost':
      return 'Открой Телемост'
    case 'settings':
      return 'Открой настройки'
    case 'docs':
      return 'Открой документацию'
    default:
      return `Открой раздел «${title}»`
  }
}
