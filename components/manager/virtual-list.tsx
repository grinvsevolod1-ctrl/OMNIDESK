'use client'

import { useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'

/**
 * Generic vertical virtualized list.
 *
 * Why this is its own component: TanStack Virtual's `useVirtualizer()` returns
 * functions the React Compiler cannot memoize, so any component that calls it is
 * skipped by the compiler (it emits `react-hooks/incompatible-library`). By
 * isolating the hook here — a tiny leaf component — the large parents that embed
 * a list (e.g. the 3.8k-line InboxView) stay fully compiled/memoized, and only
 * this negligible wrapper opts out. That matters for views with frequent
 * realtime re-renders, where losing memoization on the whole screen would be a
 * bigger regression than the DOM savings from virtualization.
 *
 * Rows are measured dynamically (variable height is fine: badges, "печатает…",
 * source chip, etc.); `estimateSize` is only the initial guess. `renderItem`
 * runs in the PARENT's scope (it's passed down as a closure), so callers keep
 * writing row JSX inline with full access to their state and handlers — no prop
 * drilling.
 */
export function VirtualList<T>({
  items,
  getItemKey,
  estimateSize = 76,
  overscan = 8,
  className,
  renderItem,
}: {
  items: T[]
  /** Stable key per item — keeps measurement/DOM identity across reorders. */
  getItemKey: (item: T, index: number) => string | number
  /** Initial per-row height guess in px (refined by real measurement). */
  estimateSize?: number
  /** Rows to render beyond the viewport on each side. */
  overscan?: number
  /** Class for the scroll container. */
  className?: string
  renderItem: (item: T, index: number) => ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Expected: TanStack Virtual returns non-memoizable functions, so the React
  // Compiler skips this leaf component. That's intentional and contained here —
  // isolating the opt-out is the whole reason this wrapper exists.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: (index) => getItemKey(items[index]!, index),
  })

  return (
    <div ref={scrollRef} className={cn('overflow-y-auto', className)}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vitem) => {
          const item = items[vitem.index]
          if (item === undefined) return null
          return (
            <div
              key={vitem.key}
              data-index={vitem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${vitem.start}px)` }}
            >
              {renderItem(item, vitem.index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
