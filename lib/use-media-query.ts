'use client'

import { useEffect, useState } from 'react'

/**
 * SSR-safe `matchMedia` hook. Returns `false` on the server and on the first
 * client render (so markup is identical and hydration never mismatches), then
 * corrects to the real value in a layout-safe effect right after mount and
 * stays in sync via the media-query listener.
 *
 * Used by the inbox to decide, at runtime, whether the open dialog gets its own
 * per-dialog header (desktop) or merges into the app header (mobile).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const update = () => setMatches(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [query])

  return matches
}

/** Tailwind `md` breakpoint (≥768px): the inbox shows list + thread side by side. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)')
}
