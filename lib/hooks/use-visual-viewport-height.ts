'use client'

import { useEffect } from 'react'

/**
 * Keeps the `--app-vh` CSS variable in sync with the REAL visible height of a
 * full-screen surface while a soft keyboard is open, so a `fixed`/full-bleed
 * chat rides above the keyboard instead of being overlaid by it.
 *
 * Why this exists: iOS Safari ignores viewport `interactive-widget`, so its
 * keyboard overlays the page and only `visualViewport` shrinks — `100dvh` stays
 * tall and the composer disappears behind the keyboard. We pin `--app-vh` to
 * `visualViewport.height` ONLY while a keyboard is actually open (inset > 120px);
 * otherwise we clear the override and let CSS `100dvh` govern, which kills the
 * stale short height that used to leave a black gap under the composer after the
 * keyboard closed. On Android `interactive-widget: resizes-content` already
 * shrank the layout viewport, so the inset stays small and CSS keeps control.
 *
 * Consume it as `style={{ height: 'var(--app-vh, 100dvh)' }}` on the root of any
 * full-screen chat surface. Shared by the dashboard shell (manager/curator
 * inbox) and the standalone god messenger so every chat behaves identically.
 */
export function useVisualViewportHeight(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    const apply = () => {
      if (!vv) return
      const keyboardInset = window.innerHeight - vv.height
      const root = document.documentElement
      if (keyboardInset > 120) {
        root.style.setProperty('--app-vh', `${Math.round(vv.height)}px`)
      } else {
        root.style.removeProperty('--app-vh')
      }
    }
    apply()
    vv?.addEventListener('resize', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
      // Leave no stale override behind when the surface unmounts.
      document.documentElement.style.removeProperty('--app-vh')
    }
  }, [])
}
