import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { SWRProvider } from '@/components/swr-provider'
import { NotificationProvider } from '@/components/manager/notification-provider'
import { NotificationGate } from '@/components/manager/notification-gate'
import { HeaderNotificationBell } from '@/components/manager/header-notification-bell'
import { LunchToggle } from '@/components/manager/lunch-toggle'
import { Fake502 } from '@/components/fake-502'
import { DictionariesProvider } from '@/components/dictionaries-provider'
import { requireManager } from '@/lib/auth'
import { getFake502, getManagerOnLunch } from '@/lib/data'
import { getDictionaries } from '@/lib/data/dictionaries'

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

  // God-panel maintenance kill-switch: when on, managers see a fake 502 instead
  // of the dashboard. The god panel is never gated by this, so it can be undone.
  if (await getFake502()) return <Fake502 />

  const onLunch = await getManagerOnLunch(user.sub)
  // Managed dictionaries (lead-status labels etc.) are resolved server-side
  // once per request so client components never flash default captions.
  const dictionaries = await getDictionaries()
  return (
    <SWRProvider>
    <DictionariesProvider value={dictionaries}>
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
    </DictionariesProvider>
    </SWRProvider>
  )
}
