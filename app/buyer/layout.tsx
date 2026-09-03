import type { ReactNode } from 'react'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import { SWRProvider } from '@/components/swr-provider'
import { requireBuyer } from '@/lib/auth'
import { getManagerById } from '@/lib/data'

const nav: NavItem[] = [{ href: '/buyer', label: 'Обзор', icon: 'overview' }]

export default async function BuyerLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireBuyer()
  const account = await getManagerById(user.sub).catch(() => null)

  return (
    <SWRProvider>
      <DashboardShell
        nav={nav}
        roleLabel="Медиабайер"
        user={{
          name: user.name,
          email: user.email,
          avatarUrl: account?.avatarUrl ?? null,
        }}
      >
        {children}
      </DashboardShell>
    </SWRProvider>
  )
}
