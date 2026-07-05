import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { requireAdmin } from '@/lib/auth'

const nav: NavItem[] = [
  { href: '/admin', label: 'Обзор', icon: 'overview' },
  { href: '/admin/managers', label: 'Менеджеры', icon: 'managers' },
  { href: '/admin/channels', label: 'Все каналы', icon: 'channels' },
  { href: '/admin/whatsapp', label: 'WhatsApp', icon: 'whatsapp' },
  { href: '/admin/proxies', label: 'Прокси', icon: 'proxies' },
  { href: '/admin/livechat', label: 'Онлайн-чат', icon: 'livechat' },
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
