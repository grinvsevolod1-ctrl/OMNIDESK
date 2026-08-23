/**
 * Нормализация Telegram-контакта куратора (миграция 146).
 *
 * Куратор может вводить контакт в двух форматах:
 *   - «@username» (или просто «username»)
 *   - ссылка на Telegram: t.me/username, https://t.me/username,
 *     telegram.me/username, telegram.dog/username
 *
 * Приводим всё к единому каноническому виду «@username» для отображения.
 * Возвращает null, если из ввода нельзя извлечь валидный username
 * (5–32 символа: латиница, цифры, подчёркивание — правила Telegram).
 */
const USERNAME_RE = /^[a-zA-Z0-9_]{5,32}$/

export function normalizeTelegramContact(input: string): string | null {
  let s = input.trim()
  if (!s) return null

  // Ссылка: убираем протокол и известные хосты Telegram.
  s = s.replace(/^https?:\/\//i, '')
  s = s.replace(/^(www\.)?(t\.me|telegram\.me|telegram\.dog)\//i, '')

  // Хвосты ссылки: ?start=..., /, пробелы.
  s = s.split(/[/?#\s]/)[0] ?? ''

  // «@username» → «username».
  if (s.startsWith('@')) s = s.slice(1)

  if (!USERNAME_RE.test(s)) return null
  return `@${s}`
}
