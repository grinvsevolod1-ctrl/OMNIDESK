import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { NotificationProvider } from '@/components/manager/notification-provider'
import { NotificationGate } from '@/components/manager/notification-gate'
import { HeaderNotificationBell } from '@/components/manager/header-notification-bell'
import { LunchToggle } from '@/components/manager/lunch-toggle'
import { requireManager } from '@/lib/auth'
import { getManagerOnLunch } from '@/lib/data'

const nav: NavItem[] = [
  { href: '/app', label: 'Обзор', icon: 'overview' },
  { href: '/app/connections', label: 'Подключения', icon: 'connections' },
  { href: '/app/inbox', label: 'Входящие', icon: 'inbox' },
  { href: '/app/quick-replies', label: 'Автоответы', icon: 'quickReplies' },
  { href: '/app/autopilot', label: 'Автопилот', icon: 'autopilot' },
  { href: '/app/meetings', label: 'Видеовстречи', icon: 'telemost' },
  { href: '/app/proxies', label: 'Прокси', icon: 'proxies' },
  { href: '/app/settings', label: 'Настройки', icon: 'settings' },
]

export default async function ManagerLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireManager()
  const onLunch = await getManagerOnLunch(user.sub)
  return (
    <NotificationProvider>
      <DashboardShell
        nav={nav}
        roleLabel="Менеджер"
        user={{ name: user.name, email: user.email }}
        headerSlot={
          <>
            <LunchToggle initialOnLunch={onLunch} />
            <HeaderNotificationBell />
          </>
        }
      >
        <NotificationGate>{children}</NotificationGate>
      </DashboardShell>
    </NotificationProvider>
  )
}
