import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { SWRProvider } from '@/components/swr-provider'
import { NotificationGate } from '@/components/manager/notification-gate'
import { NotificationProvider } from '@/components/manager/notification-provider'
import { requireCurator } from '@/lib/auth'
import { getManagerById } from '@/lib/data'
import { countUnreadConversationsForCurator } from '@/lib/data/curator-conversations'
import { TelegramContactGate } from '@/components/curator/telegram-contact-gate'
import { ImpersonationBanner } from '@/components/shared/impersonation-banner'

function buildNav(initialUnread: number): NavItem[] {
  return [
    { href: '/curator', label: 'Обзор', icon: 'overview' },
    {
      href: '/curator/chats',
      label: 'Чаты',
      icon: 'inbox',
      // Сериализуемый дескриптор (не функция!) — nav уходит из этого серверного
      // layout в клиентский DashboardShell; сам бейдж строит клиентский NavLinks.
      unreadBadge: { role: 'curator', initial: initialUnread },
    },
    { href: '/curator/settings', label: 'Настройки', icon: 'settings' },
  ]
}

export default async function CuratorLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireCurator()
  const impersonating = Boolean(user.impersonatedBy)
  // Аватарка не живёт в JWT (это был бы жирный data:-URL в cookie) — читаем
  // строку сотрудника из БД для шапки. Best-effort: без неё покажем инициалы.
  const account = await getManagerById(user.sub).catch(() => null)

  // ОБЯЗАТЕЛЬНЫЙ Telegram для кандидатов (миграция 146): пока контакт не указан,
  // куратор не может пользоваться панелью — отдаём только полноэкранный гейт без
  // навигации и доступа к разделам. Менеджеру без этого контакта нечего слать
  // кандидату при передаче лида. Как только сохранит — layout перечитает строку
  // (router.refresh в гейте) и пустит внутрь. При инспекции админом гейт не
  // применяется — админ просматривает кабинет, а не работает кандидатами.
  if (!impersonating && !account?.telegramContact?.trim()) {
    return <TelegramContactGate curatorName={user.name} />
  }

  // Стартовое значение бейджа «Чаты» — из БД, дальше живёт по push.
  const initialUnread = await countUnreadConversationsForCurator(
    user.sub,
  ).catch(() => 0)
  const nav = buildNav(initialUnread)

  return (
    <SWRProvider>
      <NotificationProvider>
        <DashboardShell
          nav={nav}
          roleLabel="Менеджер по кадрам"
          user={{
            name: user.name,
            email: user.email,
            avatarUrl: account?.avatarUrl ?? null,
          }}
        >
          {impersonating ? (
            <>
              <ImpersonationBanner
                name={user.name}
                roleLabel="Менеджер по кадрам"
              />
              {children}
            </>
          ) : (
            <NotificationGate>{children}</NotificationGate>
          )}
        </DashboardShell>
      </NotificationProvider>
    </SWRProvider>
  )
}
