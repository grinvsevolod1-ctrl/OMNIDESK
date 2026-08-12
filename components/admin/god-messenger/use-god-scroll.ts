'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message } from '@/lib/types'

/* Swipe-right-back thresholds (thread → list, anywhere in the thread). */
const THREAD_DRAG_MAX = 120
const THREAD_DRAG_TRIGGER = 70

/**
 * Smart auto-scroll + swipe-right-to-go-back for the god messenger thread,
 * extracted verbatim from god-messenger.tsx.
 *
 * Auto-scroll follows new messages ONLY while the user is already at (or near)
 * the bottom — an incoming SSE message must not yank them back down while they
 * read history (classic Telegram behaviour).
 */
export function useGodScroll({
  selectedId,
  messages,
  onSwipeBack,
}: {
  selectedId: string | null
  messages: Message[]
  onSwipeBack: () => void
}) {
  const endRef = useRef<HTMLDivElement | null>(null)
  const scrollBoxRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  // Flags our own pinToBottom scrolls so they can't be mistaken for user
  // intent in onScrollBox (see the anti-fight notes in use-thread-scroll.ts:
  // position-only re-stick + ResizeObserver re-pin = an escape-proof loop
  // that drags the user back down while they try to scroll up).
  const programmatic = useRef(false)
  // True while a freshly opened thread hasn't been positioned yet — the first
  // messages render must JUMP to the bottom instantly (no smooth animation
  // crawling down from the top of the history).
  const initialJumpPending = useRef(false)

  /** Called by the parent when the selected thread changes. */
  const resetForNewThread = useCallback(() => {
    stickToBottom.current = true
    initialJumpPending.current = true
  }, [])

  /** Called before an own send so the reply always scrolls into view. */
  const pinOnNextGrowth = useCallback(() => {
    stickToBottom.current = true
  }, [])

  const onScrollBox = useCallback(() => {
    if (programmatic.current) {
      programmatic.current = false
      return
    }
    const el = scrollBoxRef.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (fromBottom < 40) stickToBottom.current = true
    else if (fromBottom > 120) stickToBottom.current = false
    // 40..120px: dead zone — intent unchanged while the user is leaving.
  }, [])

  const pinToBottom = useCallback(() => {
    const el = scrollBoxRef.current
    if (!el) return
    programmatic.current = true
    el.scrollTop = el.scrollHeight
  }, [])

  // Upward wheel/touch gesture releases the pin INSTANTLY, before any resize
  // or SSE append can pull the view back down.
  useEffect(() => {
    const el = scrollBoxRef.current
    if (!el || !selectedId) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickToBottom.current = false
    }
    let touchY = 0
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0
      if (y > touchY + 4) stickToBottom.current = false
      touchY = y
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
    }
  }, [selectedId])

  useEffect(() => {
    if (messages.length === 0) return
    if (initialJumpPending.current) {
      // First render of a freshly opened thread: land on the newest messages
      // INSTANTLY. Double rAF waits out the initial layout so scrollHeight is
      // real (a single sync scroll can land mid-history before bubbles size).
      initialJumpPending.current = false
      pinToBottom()
      requestAnimationFrame(() => {
        pinToBottom()
        requestAnimationFrame(pinToBottom)
      })
      return
    }
    if (stickToBottom.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, pinToBottom])

  // Keep the bottom pinned as bubbles grow AFTER the initial jump — images,
  // videos and voice players finish loading asynchronously and would otherwise
  // push the newest messages back out of view (the "opens scrolled up" bug).
  useEffect(() => {
    const container = scrollBoxRef.current
    const content = container?.firstElementChild
    if (!content) return
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) pinToBottom()
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [selectedId, pinToBottom])

  /* ----- swipe right anywhere in the thread → back to list ----- */
  const [backDrag, setBackDrag] = useState(0)
  const backStart = useRef<{ x: number; y: number } | null>(null)
  const backAxis = useRef<null | 'h' | 'v'>(null)

  const onBackPointerDown = useCallback((e: React.PointerEvent) => {
    // Touch only: a mouse drag on desktop must never slide the panel. Also
    // skip on md+ layouts where the list is already visible beside the thread,
    // and NEVER claim gestures that start on interactive controls (composer,
    // buttons, media players) — that's how typing could "kick" the user back.
    if (e.pointerType !== 'touch') return
    if (window.matchMedia('(min-width: 768px)').matches) return
    const target = e.target as HTMLElement | null
    if (target?.closest('textarea, input, button, a, audio, video, [data-no-swipe]'))
      return
    backStart.current = { x: e.clientX, y: e.clientY }
    backAxis.current = null
  }, [])

  const onBackPointerMove = useCallback((e: React.PointerEvent) => {
    if (!backStart.current) return
    const dx = e.clientX - backStart.current.x
    const dy = Math.abs(e.clientY - backStart.current.y)
    // Lock the axis once, exactly like the bubble gesture: a mostly-vertical
    // move is a scroll (give up), a mostly-horizontal RIGHTWARD move is ours.
    if (backAxis.current === null) {
      if (dx > 8 && dx > dy) backAxis.current = 'h'
      else if (dy > 8 || dx < -8) backAxis.current = 'v'
    }
    if (backAxis.current === 'h') {
      setBackDrag(Math.min(Math.max(dx, 0), THREAD_DRAG_MAX))
    }
  }, [])

  const onBackPointerEnd = useCallback(() => {
    if (!backStart.current) return
    backStart.current = null
    backAxis.current = null
    setBackDrag((d) => {
      if (d >= THREAD_DRAG_TRIGGER) onSwipeBack()
      return 0
    })
  }, [onSwipeBack])

  return {
    endRef,
    scrollBoxRef,
    onScrollBox,
    resetForNewThread,
    pinOnNextGrowth,
    backDrag,
    onBackPointerDown,
    onBackPointerMove,
    onBackPointerEnd,
  }
}
