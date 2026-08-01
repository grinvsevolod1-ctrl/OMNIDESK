import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { SWRProvider } from '@/components/swr-provider'
import { Fake502 } from '@/components/fake-502'
import { requireAdmin } from '@/lib/auth'
import { getFake502 } from '@/lib/data'

const nav: NavItem[] = [
  { href: '/admin', label: 'Обзор', icon: 'overview' },
  { href: '/admin/managers', label: 'Менеджеры', icon: 'managers' },
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

  // God-panel maintenance kill-switch: when on, admins see a fake 502 instead
  // of the dashboard. The god panel is never gated by this, so it can be undone.
  if (await getFake502()) return <Fake502 />

  return (
    <SWRProvider>
      <DashboardShell
        nav={nav}
        roleLabel="Администратор"
        user={{ name: user.name, email: user.email }}
      >
        {children}
      </DashboardShell>
    </SWRProvider>
  )
}
