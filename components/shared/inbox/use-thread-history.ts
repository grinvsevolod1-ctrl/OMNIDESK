'use client'

/**
 * Thread history loading, shared by the manager and curator inboxes:
 *  - lazy hydration for threads outside the SSR preload slice (a missing key
 *    in the map means "transcript not shipped yet"; an empty array means a
 *    genuinely empty thread), and
 *  - on-demand "load older messages" (viewport anchoring for the prepend is
 *    MessageList's job — it has the DOM).
 *
 * The messages cache itself stays in the parent (the SSE handler patches it),
 * so the hook receives the state pair instead of owning it. The role plugs in
 * through `adapter` (which server actions fetch the history).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { toast } from 'sonner'
import type { Message } from '@/lib/types'
import type { ThreadAdapter } from './thread-adapter'

export function useThreadHistory({
  adapter,
  activeId,
  localMessages,
  setLocalMessages,
}: {
  adapter: Pick<ThreadAdapter, 'loadThread' | 'loadOlder'>
  activeId: string | null
  localMessages: Record<string, Message[]>
  setLocalMessages: Dispatch<SetStateAction<Record<string, Message[]>>>
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
    void adapter
      .loadThread(activeId)
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
  }, [adapter, activeId, localMessages, setLocalMessages])

  /**
   * Догрузить страницу истории. Возвращает hasMore — есть ли ещё старые
   * сообщения. Это позволяет поиску по треду долистывать до цели циклом.
   */
  const handleLoadOlder = useCallback(async (): Promise<boolean> => {
    // Параллельная загрузка уже идёт — считаем, что история ещё может быть.
    if (!activeId || loadingOlder) return Boolean(activeId)
    const current = localMessages[activeId] ?? []
    const oldest = current[0]
    if (!oldest) return false
    setLoadingOlder(true)
    try {
      const before = new Date(oldest.createdAt).toISOString()
      const res = await adapter.loadOlder(activeId, before)
      if (res.ok && res.messages.length > 0) {
        // Viewport anchoring for the prepend is done by MessageList in a
        // layout effect (synchronously, before paint, from the real DOM
        // offsets). Do NOT reintroduce `scrollTop = scrollHeight - prevHeight`
        // in a rAF here: it measured before the await, ignored the reader's
        // actual scrollTop and raced the browser's own scroll anchoring.
        setLocalMessages((prev) => {
          const existing = prev[activeId] ?? []
          const known = new Set(existing.map((m) => m.id))
          const older = res.messages.filter((m) => !known.has(m.id))
          if (older.length === 0) return prev
          return { ...prev, [activeId]: [...older, ...existing] }
        })
      }
      if (!res.hasMore) setNoOlder((p) => ({ ...p, [activeId]: true }))
      return res.ok ? res.hasMore : false
    } catch {
      toast.error('Не удалось загрузить историю')
      return false
    } finally {
      setLoadingOlder(false)
    }
  }, [adapter, activeId, loadingOlder, localMessages, setLocalMessages])

  return { threadLoading, loadingOlder, noOlder, setNoOlder, handleLoadOlder }
}
