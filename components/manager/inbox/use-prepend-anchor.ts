'use client'

import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Prepend anchoring for the thread («Загрузить ранние сообщения» / auto-load
 * at the top): the row the reader is looking at must stay exactly where it is
 * when older rows are inserted above it.
 *
 * Anchor = the FIRST rendered row; we remember its offset from the top of the
 * scroll viewport (refreshed on every commit and every scroll), and whenever a
 * commit changes which row is first while the old first row is still in the
 * DOM, we shift scrollTop by however much that old row moved. Measured from
 * real DOM rects in a layout effect — synchronous, before paint, so there is no
 * flash of the wrong position and no dependence on rAF timing. Idempotent
 * against the browser's own scroll anchoring: where Chrome already
 * compensated, the anchor has not moved and the delta is ~0; where it did not
 * (scrollTop was 0, or Safari, which has no scroll anchoring), we do the whole
 * shift. A one-frame re-check catches a late browser adjustment.
 *
 * Do NOT replace this with `scrollTop = scrollHeight - prevHeight` in a rAF
 * from the loading hook: that measured before the await, ignored the reader's
 * actual scrollTop and raced the browser — the «нажимаешь загрузка — кидает в
 * начало» bug.
 *
 * Rows must carry `data-message-id`. `deps` is whatever identifies a commit
 * that may have changed the row set (the thread array).
 */
export function usePrependAnchor(
  scrollRef: RefObject<HTMLElement | null>,
  deps: unknown,
) {
  const anchorRef = useRef<{ id: string; top: number } | null>(null)

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const first = el.querySelector<HTMLElement>('[data-message-id]')
    if (!first) {
      anchorRef.current = null
      return
    }
    anchorRef.current = {
      id: first.dataset.messageId ?? '',
      top: first.getBoundingClientRect().top - el.getBoundingClientRect().top,
    }
  }, [scrollRef])

  useLayoutEffect(() => {
    const el = scrollRef.current
    const prev = anchorRef.current
    if (el && prev && prev.id) {
      const first = el.querySelector<HTMLElement>('[data-message-id]')
      if (first && first.dataset.messageId !== prev.id) {
        const selector = `[data-message-id="${CSS.escape(prev.id)}"]`
        const restore = () => {
          const c = scrollRef.current
          const anchorEl = c?.querySelector<HTMLElement>(selector)
          if (!c || !anchorEl) return
          const delta =
            anchorEl.getBoundingClientRect().top -
            c.getBoundingClientRect().top -
            prev.top
          if (Math.abs(delta) > 1) c.scrollTop += delta
        }
        if (el.querySelector(selector)) {
          restore()
          requestAnimationFrame(restore)
        }
      }
    }
    measure()
    // `deps` is the commit identity (the thread array) — see doc comment.
  }, [deps, measure, scrollRef])

  /** Call from the container's onScroll so the anchor tracks the reader. */
  return measure
}
