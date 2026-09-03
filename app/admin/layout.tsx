import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import type { NavItem } from '@/components/dashboard-shell'
import { SWRProvider } from '@/components/swr-provider'
import { Fake502 } from '@/components/fake-502'
import { DictionariesProvider } from '@/components/dictionaries-provider'
import { AdminChrome } from '@/components/admin/os-shell/admin-chrome'
import { requireAdmin } from '@/lib/auth'
import { getFake502 } from '@/lib/data'
import { getDictionaries } from '@/lib/data/dictionaries'
import { SHELL_MODE_COOKIE } from '@/lib/admin-console/assistant'
import { detectShellInsights } from '@/lib/admin-console/insights'
import { loadConsoleSession } from '@/lib/data/console-shell'

const nav: NavItem[] = [
  { href: '/admin', label: 'Обзор', icon: 'overview' },
  {
    href: '/admin/staff',
    label: 'Персонал',
    icon: 'managers',
    children: [
      { href: '/admin/managers', label: 'Менеджеры', icon: 'managers' },
      {
        href: '/admin/curators',
        label: 'Менеджеры по кадрам',
        icon: 'managers',
      },
      { href: '/admin/heads', label: 'Руководители', icon: 'managers' },
      { href: '/admin/teams', label: 'Команды', icon: 'managers' },
      { href: '/admin/buyers', label: 'Медиабайеры', icon: 'managers' },
      { href: '/admin/sources', label: 'Источники', icon: 'channels' },
    ],
  },
  { href: '/admin/leads', label: 'Лиды', icon: 'leads' },
  { href: '/admin/ai', label: 'ИИ-ассистент', icon: 'ai' },
  {
    href: '/admin/accounts',
    label: 'Аккаунты',
    icon: 'connections',
    children: [
      { href: '/admin/accounts', label: 'Обзор', icon: 'channels' },
      { href: '/admin/whatsapp', label: 'WhatsApp', icon: 'whatsapp' },
      { href: '/admin/accounts/telegram', label: 'Telegram', icon: 'telegram' },
      { href: '/admin/accounts/vk', label: 'VK', icon: 'vk' },
      { href: '/admin/accounts/max', label: 'MAX', icon: 'max' },
      { href: '/admin/telemost', label: 'Телемост', icon: 'telemost' },
      { href: '/admin/livechat', label: 'Онлайн-чат', icon: 'livechat' },
    ],
  },
  { href: '/admin/proxies', label: 'Прокси', icon: 'proxies' },
  { href: '/admin/servers', label: 'Серверы', icon: 'servers' },
  { href: '/admin/finance', label: 'Учёт', icon: 'finance' },
  { href: '/admin/contacts', label: 'Контакты', icon: 'inbox' },
  { href: '/admin/settings', label: 'Система', icon: 'settings' },
]

export default async function AdminLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireAdmin()

  if (await getFake502()) return <Fake502 />

  const dictionaries = await getDictionaries()

  const jar = await cookies()
  const shellEnabled = jar.get(SHELL_MODE_COOKIE)?.value !== '0'

  const [insights, savedSession] = shellEnabled
    ? await Promise.all([detectShellInsights(), loadConsoleSession(user.sub)])
    : [[], null]

  return (
    <SWRProvider>
      <DictionariesProvider value={dictionaries}>
        <AdminChrome
          shellEnabled={shellEnabled}
          nav={nav}
          user={{ name: user.name, email: user.email }}
          dictionaries={dictionaries}
          insights={insights}
          savedSession={savedSession}
        >
          {children}
        </AdminChrome>
      </DictionariesProvider>
    </SWRProvider>
  )
}
