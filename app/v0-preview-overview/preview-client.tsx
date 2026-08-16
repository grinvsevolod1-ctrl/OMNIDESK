'use client'

import { SWRConfig } from 'swr'
import { OverviewTab } from '@/components/admin/overview/overview-tab'
import type { SourcesOverview } from '@/lib/data/sources'

/* ВРЕМЕННЫЙ клиент-обёртка: глушит SWR-запросы (нет сессии в песочнице). */
export function PreviewClient({ overview }: { overview: SourcesOverview }) {
  return (
    <SWRConfig
      value={{
        revalidateOnMount: false,
        revalidateOnFocus: false,
        revalidateIfStale: false,
      }}
    >
      <OverviewTab initialOverview={overview} groups={[]} channels={[]} />
    </SWRConfig>
  )
}
