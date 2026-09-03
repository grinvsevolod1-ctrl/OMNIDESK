import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { SWRProvider } from '@/components/swr-provider'
import { requireHead } from '@/lib/auth'

const nav: NavItem[] = [
  { href: '/head', label: 'Обзор', icon: 'overview' },
  { href: '/head/team', label: 'Моя команда', icon: 'managers' },
  { href: '/head/settings', label: 'Настройки', icon: 'settings' },
]

export default async function HeadLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireHead()

  return (
    <SWRProvider>
      <DashboardShell
        nav={nav}
        roleLabel="Руководитель"
        user={{ name: user.name, email: user.email }}
      >
        {children}
      </DashboardShell>
    </SWRProvider>
  )
}
