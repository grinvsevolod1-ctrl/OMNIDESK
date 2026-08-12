'use client'

import { useEffect, useRef } from 'react'
import type { Conversation } from '@/lib/types'

/**
 * Keyboard navigation for the inbox — the manager's highest-frequency screen,
 * where reaching for the mouse between dialogs adds up fast.
 *
 *   j / ArrowDown (Alt)   next conversation in the CURRENT filtered order
 *   k / ArrowUp (Alt)     previous conversation
 *
 * Plain j/k only fire when focus is NOT in an editable control, so typing a
 * message never hijacks navigation. Alt+arrows work even from the composer —
 * that's the "answer, jump to next" power path. The bare arrows are left
 * alone: the list, selects, and the composer all use them natively.
 *
 * Deliberately NOT bound: Escape (owned by dialogs/panels), Enter (composer
 * send), digits (quick-reply palette may claim them later).
 */
export function useInboxShortcuts({
  filtered,
  activeId,
  setActiveId,
}: {
  /** Conversations in the order the list currently renders them. */
  filtered: Conversation[]
  activeId: string | null
  setActiveId: (id: string | null) => void
}) {
  // Refs so the single global listener never needs re-attaching as the list
  // or selection changes (attach/detach churn on every poll otherwise).
  const stateRef = useRef({ filtered, activeId, setActiveId })
  stateRef.current = { filtered, activeId, setActiveId }

  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false
      if (el.isContentEditable) return true
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Never fight the browser or OS over modified keys we don't own.
      if (e.ctrlKey || e.metaKey) return

      const plainJk =
        !e.altKey && (e.key === 'j' || e.key === 'k') && !isEditable(e.target)
      const altArrows =
        e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')
      if (!plainJk && !altArrows) return

      const { filtered, activeId, setActiveId } = stateRef.current
      if (filtered.length === 0) return

      const forward = e.key === 'j' || e.key === 'ArrowDown'
      const idx = activeId ? filtered.findIndex((c) => c.id === activeId) : -1
      // From "nothing selected", both directions enter the list at the top —
      // matching what the eye expects after filtering.
      const next =
        idx === -1
          ? 0
          : Math.min(Math.max(idx + (forward ? 1 : -1), 0), filtered.length - 1)
      if (filtered[next].id === activeId) return

      e.preventDefault()
      setActiveId(filtered[next].id)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
