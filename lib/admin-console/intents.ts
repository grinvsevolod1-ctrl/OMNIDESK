/**
 * Client-safe section catalog + deterministic keyword classifier for the
 * OMNIDESK OS shell. The classifier is the OFFLINE fallback: when the AI
 * gateway is unreachable the shell still routes the admin to the right
 * section instead of dying.
 */

/** Admin sections the shell can navigate to (classic admin routes). */
export type ShellSection =
  | 'overview'
  | 'managers'
  | 'accounts'
  | 'finance'
  | 'channels'
  | 'proxies'
  | 'contacts'
  | 'hosting'
  | 'ai'
  | 'dictionaries'
  | 'help'

export interface ShellSectionInfo {
  id: ShellSection
  title: string
  /** Classic admin route ("/admin", "/admin/managers", ...). */
  href: string
  keywords: string[]
}

export const SHELL_SECTIONS: ShellSectionInfo[] = [
  {
    id: 'overview',
    title: 'Обзор',
    href: '/admin',
    keywords: ['обзор', 'дашборд', 'статист', 'метрик', 'сводк', 'главн'],
  },
  {
    id: 'managers',
    title: 'Менеджеры',
    href: '/admin/managers',
    keywords: ['менеджер', 'сотрудник', 'пользовател', 'логин', 'парол'],
  },
  {
    id: 'accounts',
    title: 'Аккаунты',
    href: '/admin/accounts',
    keywords: ['аккаунт', 'telegram', 'телеграм', 'whatsapp', 'ватсап', 'сесси'],
  },
  {
    id: 'finance',
    title: 'Учёт',
    href: '/admin/finance',
    keywords: ['финанс', 'учёт', 'учет', 'расход', 'бюджет', 'реклам', 'трат'],
  },
  {
    id: 'channels',
    title: 'Каналы',
    href: '/admin/channels',
    keywords: ['канал', 'виджет', 'чат на сайт', 'livechat', 'онлайн-чат'],
  },
  {
    id: 'proxies',
    title: 'Прокси',
    href: '/admin/proxies',
    keywords: ['прокси', 'proxy', 'ip'],
  },
  {
    id: 'contacts',
    title: 'Контакты',
    href: '/admin/contacts',
    keywords: ['контакт', 'лид', 'база', 'выгруз', 'csv', 'экспорт'],
  },
  {
    id: 'hosting',
    title: 'Серверы',
    href: '/admin/hosting',
    keywords: ['сервер', 'хостинг', 'деплой', 'deploy', 'ssh'],
  },
  {
    id: 'ai',
    title: 'ИИ-менеджер',
    href: '/admin/ai',
    keywords: ['ии-менеджер', 'ассистент', 'нейро', 'ai', 'бот', 'продавец'],
  },
  {
    id: 'dictionaries',
    title: 'Справочники',
    href: '/admin',
    keywords: ['справочник', 'статус', 'переимен', 'назван', 'лейбл', 'ликвид'],
  },
]

/** Deterministic keyword classification (offline fallback). */
export function classifyByKeywords(text: string): { section: ShellSection } {
  const q = text.toLowerCase()
  if (!q.trim()) return { section: 'help' }
  for (const s of SHELL_SECTIONS) {
    if (s.keywords.some((k) => q.includes(k))) return { section: s.id }
  }
  return { section: 'help' }
}
