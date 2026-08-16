'use client'

/**
 * Client-side access to the managed dictionaries (lib/dictionaries.ts).
 *
 * The RESOLVED dictionaries are loaded server-side in the admin/manager
 * layouts and passed down here once — no client fetches, no flash of default
 * labels. Components read labels through the hooks below; outside a provider
 * they transparently fall back to the defaults, so shared components keep
 * working anywhere (e.g. storybook-style isolation or the god panel).
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  DEFAULT_DICTIONARIES,
  buildLeadStatusOptions,
  type Dictionaries,
} from '@/lib/dictionaries'
import type { LeadStatusOption } from '@/lib/types'

const DictionariesContext = createContext<Dictionaries>(DEFAULT_DICTIONARIES)

export function DictionariesProvider({
  value,
  children,
}: {
  value: Dictionaries
  children: ReactNode
}) {
  return (
    <DictionariesContext.Provider value={value}>
      {children}
    </DictionariesContext.Provider>
  )
}

/** Full resolved dictionaries. */
export function useDictionaries(): Dictionaries {
  return useContext(DictionariesContext)
}

/** Lead status meta map (drop-in replacement for the old LEAD_STATUS_META). */
export function useLeadStatusMeta() {
  return useDictionaries().leadStatuses
}

/** «Не ликвид» reasons meta (replacement for NOT_LIQUID_REASON_META). */
export function useNotLiquidReasonMeta() {
  return useDictionaries().notLiquidReasons
}

/** Selectable status options (replacement for LEAD_STATUS_OPTIONS). */
export function useLeadStatusOptions(): LeadStatusOption[] {
  const dict = useDictionaries()
  return useMemo(() => buildLeadStatusOptions(dict), [dict])
}

/** Channel type captions (replacement for the scattered TYPE_LABEL maps). */
export function useChannelTypeLabels() {
  return useDictionaries().channelTypes
}

/** Proxy status captions (replacement for the local STATUS_LABEL maps). */
export function useProxyStatusLabels() {
  return useDictionaries().proxyStatuses
}
