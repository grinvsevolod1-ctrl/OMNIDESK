import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { SWRProvider } from '@/components/swr-provider'
import { NotificationProvider } from '@/components/manager/notification-provider'
import { NotificationGate } from '@/components/manager/notification-gate'
import { HeaderNotificationBell } from '@/components/manager/header-notification-bell'
import { LunchToggle } from '@/components/manager/lunch-toggle'
import { Fake502 } from '@/components/fake-502'
import { ImpersonationBanner } from '@/components/shared/impersonation-banner'
import { DictionariesProvider } from '@/components/dictionaries-provider'
import { requireManager } from '@/lib/auth'
import {
  countUnreadConversationsForManager,
  getFake502,
  getManagerById,
  getManagerOnLunch,
} from '@/lib/data'
import { getDictionaries } from '@/lib/data/dictionaries'

function buildNav(initialUnread: number): NavItem[] {
  return [
    { href: '/app', label: 'Обзор', icon: 'overview' },
    { href: '/app/connections', label: 'Подключения', icon: 'connections' },
    {
      href: '/app/inbox',
      label: 'Входящие',
      icon: 'inbox',
      // Сериализуемый дескриптор (не функция!) — nav уходит из этого серверного
      // layout в клиентский DashboardShell; сам бейдж строит клиентский NavLinks.
      unreadBadge: { role: 'manager', initial: initialUnread },
    },
    { href: '/app/leads', label: 'Мои лиды', icon: 'managers' },
    { href: '/app/quick-replies', label: 'Автоответы', icon: 'quickReplies' },
    { href: '/app/autopilot', label: 'Автопилот', icon: 'autopilot' },
    { href: '/app/meetings', label: 'Видеовстречи', icon: 'telemost' },
    { href: '/app/proxies', label: 'Прокси', icon: 'proxies' },
    { href: '/app/settings', label: 'Настройки', icon: 'settings' },
  ]
}

export default async function ManagerLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireManager()
  const impersonating = Boolean(user.impersonatedBy)

  // God-panel maintenance kill-switch: when on, managers see a fake 502 instead
  // of the dashboard. The god panel is never gated by this, so it can be undone.
  if (await getFake502()) return <Fake502 />

  const onLunch = await getManagerOnLunch(user.sub)
  // Managed dictionaries (lead-status labels etc.) are resolved server-side
  // once per request so client components never flash default captions.
  const dictionaries = await getDictionaries()
  // Аватарка для шапки (в JWT её нет — читаем строку сотрудника из БД).
  const account = await getManagerById(user.sub).catch(() => null)
  // Стартовое значение бейджа «Входящие» — из БД (без мигания на загрузке);
  // дальше клиентский NavUnreadBadge держит его живым по push.
  const initialUnread = await countUnreadConversationsForManager(
    user.sub,
  ).catch(() => 0)
  const nav = buildNav(initialUnread)
  return (
    <SWRProvider>
    <DictionariesProvider value={dictionaries}>
    <NotificationProvider>
      <DashboardShell
        nav={nav}
        roleLabel="Менеджер"
        user={{
          name: user.name,
          email: user.email,
          avatarUrl: account?.avatarUrl ?? null,
        }}
        headerSlot={
          <>
            <LunchToggle initialOnLunch={onLunch} />
            <HeaderNotificationBell />
          </>
        }
      >
        {impersonating ? (
          // Admin inspection session: the mandatory push-notification gate is
          // relaxed so the admin can view the workspace without enabling
          // notifications on their own device.
          <>
            <ImpersonationBanner name={user.name} roleLabel="Менеджер" />
            {children}
          </>
        ) : (
          <NotificationGate>{children}</NotificationGate>
        )}
      </DashboardShell>
    </NotificationProvider>
    </DictionariesProvider>
    </SWRProvider>
  )
}
