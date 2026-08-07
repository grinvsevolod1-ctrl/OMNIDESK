'use client'

/**
 * Periodic "you have not replied" nudge, extracted from inbox-view.tsx.
 *
 * If a contact's last message has gone unanswered for a while and the manager
 * is not currently looking at that thread, pop a reminder toast. Throttled per
 * conversation so it nudges instead of nagging non-stop, and paused entirely
 * while the tab is hidden.
 */

import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { Conversation } from '@/lib/types'

const REMIND_AFTER_MS = 90_000 // grace period before the first nudge
const REMIND_COOLDOWN_MS = 180_000 // re-nudge the same thread at most this often
const TICK_MS = 30_000

export function useReplyReminder({
  conversations,
  awaitingReply,
  activeId,
  onOpen,
}: {
  conversations: Conversation[]
  awaitingReply: Map<string, { waiting: boolean; since: number }>
  activeId: string | null
  onOpen: (conversationId: string) => void
}) {
  // Latest values for the reminder interval to read without re-subscribing,
  // plus a per-conversation throttle so we never spam the same thread.
  const reminderRef = useRef<{
    conversations: Conversation[]
    awaiting: Map<string, { waiting: boolean; since: number }>
    activeId: string | null
    onOpen: (conversationId: string) => void
    lastReminded: Map<string, number>
  }>({
    conversations: [],
    awaiting: new Map(),
    activeId: null,
    onOpen,
    lastReminded: new Map(),
  })

  // Keep the interval's snapshot fresh. Writing to the ref in an effect
  // (instead of during render) keeps this a proper post-render side-effect.
  useEffect(() => {
    reminderRef.current.conversations = conversations
    reminderRef.current.awaiting = awaitingReply
    reminderRef.current.activeId = activeId
    reminderRef.current.onOpen = onOpen
  }, [conversations, awaitingReply, activeId, onOpen])

  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      const { conversations, awaiting, activeId, lastReminded, onOpen } =
        reminderRef.current
      const now = Date.now()
      let pick: { id: string; name: string; since: number } | null = null
      for (const c of conversations) {
        if (c.id === activeId) continue // already on screen — no need to nag
        const a = awaiting.get(c.id)
        if (!a || !a.waiting) continue
        if (now - a.since < REMIND_AFTER_MS) continue
        if (now - (lastReminded.get(c.id) ?? 0) < REMIND_COOLDOWN_MS) continue
        // Surface the longest-waiting thread first.
        if (!pick || a.since < pick.since) {
          pick = { id: c.id, name: c.contactName, since: a.since }
        }
      }
      if (!pick) return
      reminderRef.current.lastReminded.set(pick.id, now)
      const waitedMin = Math.max(1, Math.round((now - pick.since) / 60_000))
      const picked = pick
      toast.warning(`Чувак, ты не ответил: ${picked.name}`, {
        description: `Сообщение ждёт ответа уже ${waitedMin} мин. Может, поднимешь жопу?`,
        duration: 10_000,
        action: {
          label: 'Открыть',
          onClick: () => onOpen(picked.id),
        },
      })
    }

    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  // Silence reminders for a thread the manager just dismissed or muted —
  // starts the cooldown now so the very next tick can't nag about it.
  const snoozeReminder = useCallback((conversationId: string) => {
    reminderRef.current.lastReminded.set(conversationId, Date.now())
  }, [])

  return { snoozeReminder }
}
