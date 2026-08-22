import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { SWRProvider } from '@/components/swr-provider'
import { requireBuyer } from '@/lib/auth'

const nav: NavItem[] = [{ href: '/buyer', label: 'Обзор', icon: 'overview' }]

export default async function BuyerLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireBuyer()

  return (
    <SWRProvider>
      <DashboardShell
        nav={nav}
        roleLabel="Медиабайер"
        user={{ name: user.name, email: user.email }}
      >
        {children}
      </DashboardShell>
    </SWRProvider>
  )
}
