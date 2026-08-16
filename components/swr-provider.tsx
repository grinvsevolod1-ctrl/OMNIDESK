'use client'

import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'

/**
 * App-wide SWR defaults for the authenticated dashboards.
 *
 * - `revalidateOnFocus: false` — these dashboards poll on their own cadence
 *   (or are event-driven); refetching every window focus caused a burst of
 *   duplicate requests every time an operator alt-tabbed back.
 * - `revalidateOnReconnect: true` — but do catch up after the network drops.
 * - `refreshWhenHidden`/`refreshWhenOffline` stay at their `false` defaults, so
 *   any hook that sets a `refreshInterval` automatically pauses while the tab is
 *   backgrounded and resumes on return. This is the tab-visibility guard for all
 *   SWR-based polling; manual setInterval loops guard themselves.
 *
 * Individual hooks can still override any of these per call site.
 */
export function SWRProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        keepPreviousData: true,
      }}
    >
      {children}
    </SWRConfig>
  )
}
