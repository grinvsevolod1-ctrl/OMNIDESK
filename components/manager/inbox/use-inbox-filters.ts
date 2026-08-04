'use client'

import { useCallback, useState } from 'react'
import type { ChannelType, LeadStatus, NotLiquidReason } from '@/lib/types'
import type { SortMode } from './visual'

/**
 * All list-filtering state for the inbox: full-text search, the four
 * multi-select Set filters, and the sort mode. Extracted from the InboxView
 * container so the orchestrator only wires data flow.
 *
 * Empty Set = "no filter" (show everything) — keeps the common case cheap
 * and avoids a magic 'all' sentinel.
 */
export function useInboxFilters() {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<Set<ChannelType>>(
    () => new Set(),
  )
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(() => new Set())
  const [statusFilter, setStatusFilter] = useState<Set<LeadStatus>>(
    () => new Set(),
  )
  // «Не ликвид» reason refinement (Гео / -18 / NA / TRASH). When non-empty it
  // narrows the list to not-liquid leads matching the chosen reasons.
  const [reasonFilter, setReasonFilter] = useState<Set<NotLiquidReason>>(
    () => new Set(),
  )
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  const toggleType = useCallback((value: ChannelType) => {
    setTypeFilter((prev) => toggled(prev, value))
  }, [])
  const toggleSource = useCallback((value: string) => {
    setSourceFilter((prev) => toggled(prev, value))
  }, [])
  const toggleStatus = useCallback((value: LeadStatus) => {
    setStatusFilter((prev) => toggled(prev, value))
  }, [])
  const toggleReason = useCallback((value: NotLiquidReason) => {
    setReasonFilter((prev) => toggled(prev, value))
  }, [])

  const hasActiveFilters =
    typeFilter.size > 0 ||
    sourceFilter.size > 0 ||
    statusFilter.size > 0 ||
    reasonFilter.size > 0

  const clearFilters = useCallback(() => {
    setTypeFilter(new Set())
    setSourceFilter(new Set())
    setStatusFilter(new Set())
    setReasonFilter(new Set())
  }, [])

  return {
    search,
    setSearch,
    typeFilter,
    toggleType,
    sourceFilter,
    toggleSource,
    statusFilter,
    toggleStatus,
    reasonFilter,
    toggleReason,
    sortMode,
    setSortMode,
    hasActiveFilters,
    clearFilters,
  }
}

/** Toggle a value in/out of a Set immutably (for React state updates). */
function toggled<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}
