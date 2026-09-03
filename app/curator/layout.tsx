import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { SWRProvider } from '@/components/swr-provider'
import { NotificationGate } from '@/components/manager/notification-gate'
import { NotificationProvider } from '@/components/manager/notification-provider'
import { requireCurator } from '@/lib/auth'

const nav: NavItem[] = [
  { href: '/curator', label: 'Обзор', icon: 'overview' },
  { href: '/curator/chats', label: 'Чаты', icon: 'inbox' },
  { href: '/curator/settings', label: 'Настройки', icon: 'settings' },
]

export default async function CuratorLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireCurator()

  return (
    <SWRProvider>
      <NotificationProvider>
        <DashboardShell
          nav={nav}
          roleLabel="Менеджер по кадрам"
          user={{ name: user.name, email: user.email }}
        >
          <NotificationGate>{children}</NotificationGate>
        </DashboardShell>
      </NotificationProvider>
    </SWRProvider>
  )
}
