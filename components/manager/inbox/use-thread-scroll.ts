'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Thread auto-scroll (Telegram semantics).
 *
 * stickToBottom: follow new content ONLY while the manager is already at (or
 * near) the bottom. If they scrolled up to read history, new messages /
 * visitor-typing previews must NOT yank them back down.
 *
 * Anti-fight design (the "can't scroll up" bug): sticking is driven by USER
 * INTENT, not just scroll position.
 *  - A wheel/touch gesture upward releases the pin IMMEDIATELY — before any
 *    ResizeObserver tick can re-pin. Position alone can't do this: near the
 *    bottom the user is still inside the re-stick zone, content-visibility
 *    placeholders above inflate to real heights, the observer fires,
 *    pinToBottom() drags them down, and the programmatic scroll event
 *    re-arms the pin — an escape-proof loop unless they out-scroll it.
 *  - Programmatic scrolls are flagged and their scroll events NEVER update
 *    intent, so only real user scrolling can change it.
 *  - The pin re-arms only when the user themselves scrolls back to the
 *    bottom (< 40px), an explicit "follow again" gesture.
 *
 * The hook owns the scroll-container ref and returns it so the parent can
 * also use it for the "load older" prepend anchoring.
 */
export function useThreadScroll({
  activeId,
  threadLength,
  activeTypingDraft,
}: {
  activeId: string | null
  threadLength: number
  activeTypingDraft: string
}) {
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  // Set right before every programmatic scroll; the scroll handler consumes
  // it so pinToBottom() can never be mistaken for user intent.
  const programmatic = useRef(false)

  const pinToBottom = useCallback(() => {
    const el = messagesScrollRef.current
    if (!el) return
    programmatic.current = true
    el.scrollTop = el.scrollHeight
  }, [])

  const handleThreadScroll = useCallback(() => {
    if (programmatic.current) {
      // Our own pinToBottom — not the user. Consume and keep intent as-is.
      programmatic.current = false
      return
    }
    const el = messagesScrollRef.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (fromBottom < 40) {
      // User themselves returned to the bottom → follow new content again.
      stickToBottom.current = true
    } else if (fromBottom > 120) {
      // Clearly reading history (covers scrollbar drags and keyboard paging,
      // which don't emit wheel/touch events).
      stickToBottom.current = false
    }
    // 40..120px: dead zone — intent unchanged, so bubbles inflating under the
    // viewport can't flip the pin back on while the user is leaving.
  }, [])

  // Upward gesture = "I'm reading history": release the pin instantly, before
  // any resize/append effect gets a chance to pull the view back down.
  useEffect(() => {
    const el = messagesScrollRef.current
    if (!el || !activeId) return

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickToBottom.current = false
    }
    let touchY = 0
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0
      // Finger moving down = content scrolling up.
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
  }, [activeId])

  // Opening a thread: jump STRAIGHT to the newest messages, instantly. A double
  // rAF waits out the first real layout pass — with `content-visibility: auto`
  // bubbles, the initial scrollHeight is based on 56px placeholder sizes, so a
  // single synchronous scroll lands mid-history (the "opens at the top" bug).
  useEffect(() => {
    if (!activeId) return
    stickToBottom.current = true
    pinToBottom()
    requestAnimationFrame(() => {
      pinToBottom()
      requestAnimationFrame(pinToBottom)
    })
  }, [activeId, pinToBottom])

  // While pinned, keep the bottom in view as content grows AFTER the initial
  // scroll: image/video/voice bubbles finish loading, content-visibility
  // placeholders get their real heights, the visitor's live draft expands. A
  // ResizeObserver on the scroll content catches all of those without polling.
  useEffect(() => {
    const container = messagesScrollRef.current
    const content = container?.firstElementChild
    if (!content) return
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) pinToBottom()
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [activeId, pinToBottom])

  // New message appended / visitor draft preview changed → follow, but only
  // when already at the bottom.
  useEffect(() => {
    if (stickToBottom.current) pinToBottom()
  }, [threadLength, activeTypingDraft, pinToBottom])

  return { messagesScrollRef, handleThreadScroll }
}
