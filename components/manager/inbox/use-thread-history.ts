'use client'

/**
 * Thread history loading, extracted from inbox-view.tsx:
 *  - lazy hydration for threads outside the SSR preload slice (a missing key
 *    in the map means "transcript not shipped yet"; an empty array means a
 *    genuinely empty thread), and
 *  - on-demand "load older messages" with scroll-position preservation.
 *
 * The messages cache itself stays in the parent (the SSE handler patches it),
 * so the hook receives the state pair instead of owning it.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import { toast } from 'sonner'
import {
  loadOlderMessagesAction,
  loadThreadMessagesAction,
} from '@/app/actions/messages'
import type { Message } from '@/lib/types'

export function useThreadHistory({
  activeId,
  localMessages,
  setLocalMessages,
  messagesScrollRef,
}: {
  activeId: string | null
  localMessages: Record<string, Message[]>
  setLocalMessages: Dispatch<SetStateAction<Record<string, Message[]>>>
  messagesScrollRef: RefObject<HTMLDivElement | null>
}) {
  // "Load older messages" state. Threads hydrate with only the most-recent
  // slice (see MESSAGE_HISTORY_LIMIT server-side); `noOlder` marks threads
  // with nothing left to load.
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [noOlder, setNoOlder] = useState<Record<string, boolean>>({})

  // First open of a thread outside the preload slice fetches history once.
  const [threadLoading, setThreadLoading] = useState(false)
  const hydratingRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeId || activeId in localMessages) return
    if (hydratingRef.current === activeId) return
    hydratingRef.current = activeId
    setThreadLoading(true)
    void loadThreadMessagesAction(activeId)
      .then((res) => {
        if (hydratingRef.current !== activeId) return
        setLocalMessages((prev) => {
          // An optimistic send may have created the key mid-flight — merge
          // the fetched history UNDER those messages instead of dropping it.
          const existing = prev[activeId]
          if (!existing || existing.length === 0)
            return { ...prev, [activeId]: res.ok ? res.messages : [] }
          if (!res.ok) return prev
          const known = new Set(existing.map((m) => m.id))
          const older = res.messages.filter((m) => !known.has(m.id))
          return older.length === 0
            ? prev
            : { ...prev, [activeId]: [...older, ...existing] }
        })
      })
      .catch(() => toast.error('Не удалось загрузить переписку'))
      .finally(() => {
        if (hydratingRef.current === activeId) {
          hydratingRef.current = null
          setThreadLoading(false)
        }
      })
  }, [activeId, localMessages, setLocalMessages])

  const handleLoadOlder = useCallback(async () => {
    if (!activeId || loadingOlder) return
    const current = localMessages[activeId] ?? []
    const oldest = current[0]
    if (!oldest) return
    setLoadingOlder(true)
    const container = messagesScrollRef.current
    const prevHeight = container?.scrollHeight ?? 0
    try {
      const before = new Date(oldest.createdAt).toISOString()
      const res = await loadOlderMessagesAction(activeId, before)
      if (res.ok && res.messages.length > 0) {
        setLocalMessages((prev) => {
          const existing = prev[activeId] ?? []
          const known = new Set(existing.map((m) => m.id))
          const older = res.messages.filter((m) => !known.has(m.id))
          if (older.length === 0) return prev
          return { ...prev, [activeId]: [...older, ...existing] }
        })
        // Keep the viewport anchored to the same message after older ones are
        // prepended above it (otherwise the list would jump to the top).
        requestAnimationFrame(() => {
          const c = messagesScrollRef.current
          if (c) c.scrollTop = c.scrollHeight - prevHeight
        })
      }
      if (!res.hasMore) setNoOlder((p) => ({ ...p, [activeId]: true }))
    } catch {
      toast.error('Не удалось загрузить историю')
    } finally {
      setLoadingOlder(false)
    }
  }, [
    activeId,
    loadingOlder,
    localMessages,
    messagesScrollRef,
    setLocalMessages,
  ])

  return { threadLoading, loadingOlder, noOlder, setNoOlder, handleLoadOlder }
}
