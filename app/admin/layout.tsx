import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { requireAdmin } from '@/lib/auth'

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
  return (
    <DashboardShell
      nav={nav}
      roleLabel="Администратор"
      user={{ name: user.name, email: user.email }}
    >
      {children}
    </DashboardShell>
  )
}
