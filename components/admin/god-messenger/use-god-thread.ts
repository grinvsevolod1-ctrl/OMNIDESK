'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  secretFetchThreadAction,
  secretListConversationsAction,
  secretMarkThreadReadAction,
  type ConversationWithManager,
} from '@/app/actions/admin-secret'
import type { Message } from '@/lib/types'

/**
 * Data layer of the god messenger: conversation-list loading, thread loading
 * with an in-memory LRU cache, selection ⇄ URL sync, network/tab resync and
 * live updates over the admin SSE stream. Extracted verbatim from
 * god-messenger.tsx.
 *
 * `onThreadSwitch` lets the parent reset its own per-thread state (composer
 * extras, scroll pins, render window) whenever the selection changes; it is
 * read through a ref so an inline callback can't retrigger the effect.
 */
export function useGodThread({
  deepLinkId,
  search,
  onThreadSwitch,
}: {
  deepLinkId: string | null
  search: string
  onThreadSwitch: () => void
}) {
  const [conversations, setConversations] = useState<ConversationWithManager[]>([])
  const [loadingList, setLoadingList] = useState(true)

  const [selectedId, setSelectedId] = useState<string | null>(deepLinkId)
  const [conversation, setConversation] = useState<ConversationWithManager | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingThread, setLoadingThread] = useState(false)
  const [live, setLive] = useState(false)

  const selectedIdRef = useRef<string | null>(selectedId)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  const onThreadSwitchRef = useRef(onThreadSwitch)
  useEffect(() => {
    onThreadSwitchRef.current = onThreadSwitch
  }, [onThreadSwitch])

  const listRefetch = useRef<ReturnType<typeof setTimeout> | null>(null)
  const threadRefetch = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialListLoaded = useRef(false)
  const hadConnected = useRef(false)

  /* In-memory cache of already-visited threads. Re-opening a dialog paints
   * instantly from cache (zero skeleton, zero black screen) while a silent
   * refetch brings it up to date — the Telegram pattern. Bounded LRU-ish:
   * oldest entry evicted past CACHE_MAX to keep memory flat over a long
   * god-panel session. */
  const threadCache = useRef(
    new Map<
      string,
      { conversation: ConversationWithManager; messages: Message[] }
    >(),
  )
  const cacheThread = useCallback(
    (id: string, conversation: ConversationWithManager, messages: Message[]) => {
      const cache = threadCache.current
      cache.delete(id)
      cache.set(id, { conversation, messages })
      const CACHE_MAX = 30
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
    },
    [],
  )

  /* ----- selection ⇄ URL sync -----
   * The open thread id lives in ?c=. If ANYTHING remounts this component
   * (router refresh, HMR, tab restore), the open dialog is restored instead of
   * kicking the user back to the chat list mid-conversation. replaceState only
   * — no navigation, no RSC round-trip. */
  const selectThread = useCallback((id: string | null) => {
    setSelectedId(id)
    try {
      const url = new URL(window.location.href)
      if (id) url.searchParams.set('c', id)
      else url.searchParams.delete('c')
      window.history.replaceState(null, '', url.toString())
    } catch {
      /* URL sync is best-effort */
    }
  }, [])

  /* ----- list loading -----
   * Resilient by design. Server actions fail transiently ALL the time on
   * mobile (phone sleeping, network switching, dev-server recompiles) and the
   * old code turned every single hiccup into an error toast — even for
   * background refetches where perfectly good data was already on screen.
   *
   * Policy:
   *  - every load retries up to 3 times with exponential backoff (0.5s/1.5s/3s)
   *  - background (silent) failures NEVER toast: stale data stays visible and
   *    the next SSE tick / resync retries anyway
   *  - only a failed INITIAL load (nothing on screen yet) surfaces an error,
   *    with a retry button so the user isn't stuck staring at a dead screen */
  const listSeq = useRef(0)
  // Stable self-references for the toast retry buttons (a useCallback can't
  // legally reference itself before declaration).
  const loadListRef = useRef<(opts?: { silent?: boolean }) => void>(() => {})
  const loadThreadRef = useRef<(id: string, opts?: { silent?: boolean }) => void>(
    () => {},
  )
  const loadList = useCallback(
    async (opts?: { silent?: boolean }) => {
      const seq = ++listSeq.current
      if (!opts?.silent && !initialListLoaded.current) setLoadingList(true)
      let lastError: unknown = null
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500 * 3 ** (attempt - 1)))
          // A newer load superseded this one while we were backing off.
          if (listSeq.current !== seq) return
        }
        try {
          const rows = await secretListConversationsAction({
            search,
            channelType: 'all',
          })
          if (listSeq.current !== seq) return
          setConversations(rows)
          initialListLoaded.current = true
          setLoadingList(false)
          return
        } catch (err) {
          lastError = err
        }
      }
      if (listSeq.current !== seq) return
      setLoadingList(false)
      console.error('[messenger] list load failed after retries:', lastError)
      // Data already on screen → fail silently, background refresh will win.
      if (initialListLoaded.current || opts?.silent) return
      toast.error('Не удалось загрузить диалоги', {
        action: { label: 'Повторить', onClick: () => loadListRef.current() },
        duration: 8000,
      })
    },
    [search],
  )
  useEffect(() => {
    loadListRef.current = (opts) => void loadList(opts)
  }, [loadList])

  // Initial load fires immediately; subsequent search keystrokes are debounced
  // and SILENT (the previous list stays on screen — no spinner flash per key).
  useEffect(() => {
    if (!initialListLoaded.current) {
      void loadList()
      return
    }
    const id = setTimeout(() => void loadList({ silent: true }), 300)
    return () => clearTimeout(id)
  }, [loadList])

  /* ----- thread loading -----
   * Same resilience policy as the list: retry with backoff, never toast for a
   * background refresh (messages already on screen), retry button otherwise. */
  const loadThread = useCallback(
    async (id: string, opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoadingThread(true)
      let lastError: unknown = null
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500 * 3 ** (attempt - 1)))
          // The user switched threads while we were backing off — abandon.
          if (selectedIdRef.current !== id) return
        }
        try {
          const res = await secretFetchThreadAction(id)
          // Race guard: the user may have switched threads while loading.
          if (selectedIdRef.current !== id) return
          if (res.ok) {
            setConversation(res.conversation)
            setMessages(res.messages)
            if (res.conversation) cacheThread(id, res.conversation, res.messages)
          } else {
            // Business-level "not found" — retrying won't change the answer.
            // Send the user back to the list instead of leaving them stuck on
            // an endless skeleton for a thread that will never load.
            toast.error(res.message ?? 'Диалог недоступен')
            threadCache.current.delete(id)
            selectThread(null)
          }
          setLoadingThread(false)
          return
        } catch (err) {
          lastError = err
        }
      }
      if (selectedIdRef.current !== id) return
      setLoadingThread(false)
      console.error('[messenger] thread load failed after retries:', lastError)
      // Messages already on screen (silent refresh) → keep them, no toast.
      if (opts?.silent) return
      toast.error('Не удалось загрузить переписку', {
        action: { label: 'Повторить', onClick: () => loadThreadRef.current(id) },
        duration: 8000,
      })
    },
    [cacheThread, selectThread],
  )
  useEffect(() => {
    loadThreadRef.current = (id, opts) => void loadThread(id, opts)
  }, [loadThread])

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    onThreadSwitchRef.current()
    if (selectedId) {
      const cached = threadCache.current.get(selectedId)
      if (cached) {
        // Instant paint from cache, then a silent refetch reconciles. No
        // skeleton, no black screen, no flash of the previous thread.
        setConversation(cached.conversation)
        setMessages(cached.messages)
        void loadThread(selectedId, { silent: true })
      } else {
        // First visit: clear the PREVIOUS thread's data so the skeleton
        // shows instead of stale messages under the wrong header.
        setConversation(null)
        setMessages([])
        void loadThread(selectedId)
      }
    } else {
      setConversation(null)
      setMessages([])
    }
  }, [selectedId, loadThread])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* ----- network / tab-visibility resync -----
   * The most common real failure mode on the phone: the tab goes to
   * background, the OS drops the connection, the user comes back and the
   * screen is stale (or the next refetch fails and used to toast an error).
   * Instead: the moment the browser reports we're back online — or the tab
   * becomes visible again — silently resync everything. */
  useEffect(() => {
    const resync = () => {
      void loadList({ silent: true })
      const id = selectedIdRef.current
      if (id) void loadThread(id, { silent: true })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') resync()
    }
    window.addEventListener('online', resync)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', resync)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadList, loadThread])

  /* ----- live updates via admin SSE ----- */
  useEffect(() => {
    const es = new EventSource('/api/wijegniwjgwjog/stream')

    es.addEventListener('ready', () => {
      setLive(true)
      // RECONNECT resync: any message that arrived while the stream was down
      // would otherwise be silently missing until the user re-opened the
      // thread. On every reconnect (not the first connect) refetch both the
      // open thread and the list, silently.
      if (hadConnected.current) {
        const id = selectedIdRef.current
        if (id) void loadThread(id, { silent: true })
        void loadList({ silent: true })
      }
      hadConnected.current = true
    })
    es.onerror = () => setLive(false)

    es.addEventListener('update', (ev) => {
      let data: {
        type?: string
        event?: string
        conversationId?: string
        id?: string
        direction?: 'in' | 'out'
        body?: string
        author?: string
        createdAt?: string
      }
      try {
        data = JSON.parse((ev as MessageEvent).data)
      } catch {
        return
      }

      const forSelected =
        Boolean(data.conversationId) &&
        data.conversationId === selectedIdRef.current

      if (data.type === 'message' && forSelected) {
        if (data.event !== 'update' && data.id) {
          // New message in the open thread → append (dedup by id: our own
          // optimistic sends arrive here a second time).
          setMessages((prev) => {
            if (prev.some((m) => m.id === data.id)) return prev
            return [
              ...prev,
              {
                id: data.id as string,
                conversationId: data.conversationId as string,
                direction: (data.direction ?? 'out') as 'in' | 'out',
                body: data.body ?? '',
                author: data.author ?? '',
                createdAt: data.createdAt ?? new Date().toISOString(),
              },
            ]
          })
          // A manager reply landed while this thread is open on screen — the
          // user is reading it right now, so stamp the god-side read receipt
          // before the debounced list refetch computes the unread badge.
          if (data.direction === 'out') {
            void secretMarkThreadReadAction(data.conversationId as string)
          }
        } else {
          // A message changed IN PLACE (edited / deleted / reaction). The SSE
          // payload doesn't carry the full new state, so refetch the thread
          // silently (debounced — bursts collapse to one request).
          if (threadRefetch.current) clearTimeout(threadRefetch.current)
          threadRefetch.current = setTimeout(() => {
            const id = selectedIdRef.current
            if (id) void loadThread(id, { silent: true })
          }, 300)
        }
      }

      if (data.type === 'message' || data.type === 'conversation') {
        if (listRefetch.current) clearTimeout(listRefetch.current)
        listRefetch.current = setTimeout(() => void loadList({ silent: true }), 400)
      }
    })

    return () => {
      es.close()
      if (listRefetch.current) clearTimeout(listRefetch.current)
      if (threadRefetch.current) clearTimeout(threadRefetch.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    conversations,
    loadingList,
    selectedId,
    selectedIdRef,
    conversation,
    messages,
    setMessages,
    loadingThread,
    live,
    selectThread,
    loadList,
    loadThreadRef,
  }
}
