'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Thread auto-scroll (Telegram semantics), extracted verbatim from
 * inbox-view.tsx.
 *
 * stickToBottom: follow new content ONLY while the manager is already at (or
 * near) the bottom. If they scrolled up to read history, new messages /
 * visitor-typing previews must NOT yank them back down.
 *
 * The hook owns the scroll-container ref and returns it so the parent can also
 * use it for the "load older" prepend anchoring.
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

  const pinToBottom = useCallback(() => {
    const el = messagesScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const handleThreadScroll = useCallback(() => {
    const el = messagesScrollRef.current
    if (!el) return
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

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
