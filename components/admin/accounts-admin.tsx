'use client'

import { CreateAccountCard } from '@/components/admin/create-account-card'
import { AccountsTable } from '@/components/admin/accounts-table'
import type { CreatableType } from '@/components/admin/account-shared'
import type { Manager, Proxy } from '@/lib/types'
import type { AdminChannel } from '@/lib/data'

// Re-export so existing imports (app/admin/accounts/page.tsx) keep working.
export { AccountsTable } from '@/components/admin/accounts-table'

export function AccountsAdmin({
  channels,
  proxies,
  managers,
  proxyUsage,
  workerOnline,
  only,
}: {
  channels: AdminChannel[]
  proxies: Proxy[]
  managers: Manager[]
  proxyUsage: Record<string, string[]>
  workerOnline: boolean
  /** Restrict the create form and table to a single source type. */
  only?: CreatableType
}) {
  const visibleChannels = only
    ? channels.filter((c) => c.type === only)
    : channels
  return (
    <div className="flex flex-col gap-6">
      <CreateAccountCard
        proxies={proxies}
        managers={managers}
        proxyUsage={proxyUsage}
        workerOnline={workerOnline}
        only={only}
      />
      <AccountsTable
        channels={visibleChannels}
        proxies={proxies}
        proxyUsage={proxyUsage}
      />
    </div>
  )
}
