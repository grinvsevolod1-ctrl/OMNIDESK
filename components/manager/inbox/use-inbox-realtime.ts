'use client'

/**
 * Realtime layer for the manager inbox, extracted from inbox-view.tsx.
 *
 * Owns the single `/api/stream` EventSource subscription plus the ephemeral
 * "visitor is typing" and "visitor presence" state (with their staleness sweep)
 * and the connection sync indicator. It talks to the host component through just
 * two seams: it patches in-place message changes via the passed `setLocalMessages`
 * dispatcher, and debounces every other event into a single `router.refresh()`.
 * Keeping all of this in a hook means InboxView no longer re-declares ~180 lines
 * of subscription wiring inline.
 */

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { useRouter } from 'next/navigation'
import type { Message } from '@/lib/types'
import type { PresenceState } from '@/components/manager/inbox/visual'

/**
 * Shape of a parsed `/api/stream` SSE payload we care about on the client.
 * Mirrors the server's RealtimeEvent but kept local so this client component
 * never imports the server-only realtime module (which pulls in `pg`).
 */
interface RealtimeStreamEvent {
  type?: 'message' | 'conversation' | 'channel' | 'typing'
  event?: 'insert' | 'update'
  conversationId?: string
  id?: string
  reactions?: Array<{ emoji: string; fromMe: boolean }> | null
  deletedAt?: string | null
  deletedOrigin?: 'self' | 'remote' | null
  status?: string
  /** Failure reason for a message 'update' whose status is 'failed'. */
  errorReason?: string | null
  // Typing pings (visitor → manager).
  actor?: 'visitor' | 'agent'
  typing?: boolean
  draft?: string
  // Presence pings (visitor → manager).
  presence?: PresenceState
  contactName?: string
}

/** Live "visitor is typing" state for a conversation. */
export interface VisitorTyping {
  draft: string
  name: string
  /** Epoch ms when this ping arrived; used to auto-expire a stale indicator. */
  at: number
}

/** Auto-clear a typing indicator if no fresh ping arrives within this window. */
const TYPING_TTL_MS = 6_000

/** Live "visitor presence" state for a conversation. */
export interface VisitorPresence {
  state: PresenceState
  /** Epoch ms of the last ping; a stale entry is downgraded to 'left'. */
  at: number
}

/**
 * If no presence ping (incl. the widget's 25s heartbeat) arrives within this
 * window, the visitor is treated as gone — covers crashes / network loss where
 * the 'left' beacon never fired.
 */
const PRESENCE_TTL_MS = 60_000

export function useInboxRealtime({
  router,
  setLocalMessages,
}: {
  router: ReturnType<typeof useRouter>
  setLocalMessages: Dispatch<SetStateAction<Record<string, Message[]>>>
}) {
  const [syncState, setSyncState] = useState<'connecting' | 'live' | 'offline'>(
    'connecting',
  )
  // Live "visitor is typing" state, keyed by conversation id. Patched by the
  // SSE 'typing' handler and swept for staleness on an interval.
  const [typingByConv, setTypingByConv] = useState<
    Record<string, VisitorTyping>
  >({})
  // Live "visitor presence" state, keyed by conversation id. Patched by the SSE
  // 'presence' handler; stale entries are downgraded to 'left' by the sweep.
  const [presenceByConv, setPresenceByConv] = useState<
    Record<string, VisitorPresence>
  >({})

  // Realtime: refresh on worker updates and track connection state.
  useEffect(() => {
    // Coalesce bursts of realtime events into a single server refetch.
    // router.refresh() re-runs the entire server component tree (re-querying
    // all conversations + messages), so calling it once per event caused a
    // refresh storm whenever several conversations were active at once.
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    // Set when an event asked for a refresh while the tab was hidden, so we can
    // catch up in a single refetch the moment the manager returns.
    let pendingWhileHidden = false
    const scheduleRefresh = () => {
      // Skip the (expensive) full server-tree refetch while the tab is hidden —
      // the manager isn't looking, and browsers throttle background timers
      // anyway. We remember that data changed and refresh once on refocus.
      // In-place message patches above still apply; only the whole-tree refetch
      // is deferred, so nothing is lost.
      if (typeof document !== 'undefined' && document.hidden) {
        pendingWhileHidden = true
        return
      }
      if (refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        router.refresh()
      }, 400)
    }
    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      if (!pendingWhileHidden) return
      pendingWhileHidden = false
      // Back in view with stale data queued: catch up immediately (no debounce).
      if (refreshTimer) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
      router.refresh()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    const es = new EventSource('/api/stream')
    es.addEventListener('ready', () => setSyncState('live'))
    es.onopen = () => setSyncState('live')
    es.addEventListener('update', (e) => {
      setSyncState('live')
      let data: RealtimeStreamEvent | null = null
      try {
        data = JSON.parse((e as MessageEvent).data) as RealtimeStreamEvent
      } catch {
        data = null
      }
      // Message changed in place (reaction toggled / soft-deleted): patch just
      // that message locally so the change appears instantly without a full
      // server refetch (and without clobbering other optimistic state).
      if (
        data &&
        data.type === 'message' &&
        data.event === 'update' &&
        data.conversationId &&
        data.id
      ) {
        const convId = data.conversationId
        const msgId = data.id
        const deletedAt = data.deletedAt ?? null
        const isDeleted = Boolean(deletedAt)
        const deletedOrigin =
          data.deletedOrigin === 'self' || data.deletedOrigin === 'remote'
            ? data.deletedOrigin
            : undefined
        const reactions = Array.isArray(data.reactions)
          ? data.reactions.filter((r) => r && typeof r.emoji === 'string')
          : []
        const nextStatus = data.status as Message['status'] | undefined
        const nextErrorReason =
          typeof data.errorReason === 'string' ? data.errorReason : undefined
        setLocalMessages((prev) => {
          const list = prev[convId]
          if (!list) return prev
          return {
            ...prev,
            [convId]: list.map((m) =>
              m.id === msgId
                ? isDeleted
                  ? {
                      // Preserve the original content (body + media); just stamp
                      // the deleted marker so nothing is lost in the thread.
                      ...m,
                      deletedAt: deletedAt ?? new Date().toISOString(),
                      deletedOrigin: deletedOrigin ?? m.deletedOrigin,
                    }
                  : {
                      ...m,
                      reactions: reactions.length ? reactions : undefined,
                      ...(nextStatus ? { status: nextStatus } : {}),
                      ...(nextStatus === 'failed'
                        ? { errorReason: nextErrorReason }
                        : {}),
                    }
                : m,
            ),
          }
        })
        return
      }
      // Everything else (new inbound message, conversation/channel changes):
      // pull fresh server data (debounced to avoid a refresh storm).
      scheduleRefresh()
    })
    // Ephemeral "visitor is typing" pings (with a live draft preview). Kept in
    // local state only — never persisted, never trigger a refetch.
    es.addEventListener('typing', (e) => {
      let data: RealtimeStreamEvent | null = null
      try {
        data = JSON.parse((e as MessageEvent).data) as RealtimeStreamEvent
      } catch {
        data = null
      }
      if (!data || data.actor !== 'visitor' || !data.conversationId) return
      const convId = data.conversationId
      if (data.typing === false) {
        setTypingByConv((prev) => {
          if (!prev[convId]) return prev
          const next = { ...prev }
          delete next[convId]
          return next
        })
        return
      }
      setTypingByConv((prev) => ({
        ...prev,
        [convId]: {
          draft: data.draft ?? '',
          name: data.contactName ?? 'Посетитель',
          at: Date.now(),
        },
      }))
    })
    // Ephemeral visitor presence (on the site / in chat / away / left). Local
    // state only — never persisted, never triggers a refetch.
    es.addEventListener('presence', (e) => {
      let data: RealtimeStreamEvent | null = null
      try {
        data = JSON.parse((e as MessageEvent).data) as RealtimeStreamEvent
      } catch {
        data = null
      }
      if (!data || data.actor !== 'visitor' || !data.conversationId) return
      if (!data.presence) return
      const convId = data.conversationId
      const state = data.presence
      setPresenceByConv((prev) => ({
        ...prev,
        [convId]: { state, at: Date.now() },
      }))
    })
    es.onerror = () => setSyncState('offline')
    // Sweep stale typing indicators (in case a "stopped" ping is ever lost).
    const sweep = setInterval(() => {
      setTypingByConv((prev) => {
        const now = Date.now()
        let changed = false
        const next: Record<string, VisitorTyping> = {}
        for (const [id, t] of Object.entries(prev)) {
          if (now - t.at < TYPING_TTL_MS) next[id] = t
          else changed = true
        }
        return changed ? next : prev
      })
      // Downgrade stale presence to 'left' (kept in place so the manager still
      // sees the last-known status rather than it vanishing).
      setPresenceByConv((prev) => {
        const now = Date.now()
        let changed = false
        const next: Record<string, VisitorPresence> = {}
        for (const [id, p] of Object.entries(prev)) {
          if (p.state !== 'left' && now - p.at > PRESENCE_TTL_MS) {
            next[id] = { state: 'left', at: p.at }
            changed = true
          } else {
            next[id] = p
          }
        }
        return changed ? next : prev
      })
    }, 1_000)
    return () => {
      es.close()
      clearInterval(sweep)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (refreshTimer) clearTimeout(refreshTimer)
    }
  }, [router, setLocalMessages])

  return { syncState, typingByConv, presenceByConv }
}
