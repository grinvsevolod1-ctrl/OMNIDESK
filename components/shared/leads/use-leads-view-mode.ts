'use client'

import { useCallback, useEffect, useState } from 'react'

export type LeadsViewMode = 'list' | 'grid'

/**
 * Shared list/grid view-mode toggle backed by localStorage, used by every
 * role's leads view (curator, head — and available to others). The saved
 * choice is read AFTER mount so SSR stays deterministic (no localStorage on
 * the server) and survives re-login. Pass a role-unique storage key.
 */
export function useLeadsViewMode(storageKey: string): {
  view: LeadsViewMode
  switchView: (v: LeadsViewMode) => void
} {
  const [view, setView] = useState<LeadsViewMode>('list')

  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration: localStorage is unavailable on the server, so the saved choice can only be restored after mount
    if (saved === 'grid' || saved === 'list') setView(saved)
  }, [storageKey])

  const switchView = useCallback(
    (v: LeadsViewMode) => {
      setView(v)
      window.localStorage.setItem(storageKey, v)
    },
    [storageKey],
  )

  return { view, switchView }
}
