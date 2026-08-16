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
  | 'whatsapp'
  | 'livechat'
  | 'telemost'
  | 'settings'
  | 'docs'
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
    // WhatsApp lives on its own page (/admin/whatsapp) — keep its keywords there.
    keywords: ['аккаунт', 'telegram', 'телеграм', 'сесси', 'vk', 'вконтакте', 'max', 'макс'],
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
    // The servers console lives at /admin/servers (there is no /admin/hosting).
    href: '/admin/servers',
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
  {
    id: 'whatsapp',
    title: 'WhatsApp',
    href: '/admin/whatsapp',
    keywords: ['whatsapp', 'ватсап', 'вацап', 'wa-аккаунт'],
  },
  {
    id: 'livechat',
    title: 'Онлайн-чат',
    href: '/admin/livechat',
    keywords: ['онлайн-чат', 'лайвчат', 'чат на сайте', 'виджет чата'],
  },
  {
    id: 'telemost',
    title: 'Телемост',
    href: '/admin/telemost',
    keywords: ['телемост', 'видеовстреч', 'видеозвон', 'созвон'],
  },
  {
    id: 'settings',
    title: 'Настройки',
    href: '/admin/settings',
    keywords: ['настройк', 'конфигурац', 'параметр систем'],
  },
  {
    id: 'docs',
    title: 'Документация',
    href: '/admin/docs',
    keywords: ['документац', 'инструкц', 'справк', 'руководств', 'мануал'],
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
