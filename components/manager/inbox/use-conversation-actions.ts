'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type MutableRefObject,
} from 'react'
import type { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toggleConversationAiAction } from '@/app/actions/messages'
import {
  dismissReplyReminderAction,
  setConversationMutedAction,
  setLeadStatusAction,
} from '@/app/actions/leads'
import { LEAD_STATUS_OPTIONS } from '@/lib/types'
import type {
  Conversation,
  LeadStatus,
  NotLiquidReason,
} from '@/lib/types'

/**
 * Оптимистичные оверрайды диалогов + действия над ними: статус лида,
 * «ответ не нужен», мьют и переключение ИИ. Вынесено из inbox-view, чтобы
 * оркестратор не держал 8 useState и 4 функции-действия.
 *
 * `snoozeReminderRef` — ссылка на snoozeReminder из useReplyReminder:
 * реминдер зависит от awaitingReply, который зависит от оверрайдов этого
 * хука, поэтому прямая передача создала бы цикл. Контейнер заполняет ref
 * после вызова useReplyReminder.
 */
export function useConversationActions({
  rawConversations,
  ownedChannelIds,
  router,
  snoozeReminderRef,
}: {
  rawConversations: Conversation[]
  ownedChannelIds: string[]
  router: ReturnType<typeof useRouter>
  snoozeReminderRef: MutableRefObject<(conversationId: string) => void>
}) {
  const [statusPending, startStatusTransition] = useTransition()

  // Optimistic lead-status overrides (conversationId -> status snapshot).
  // Applied in the merge memo below so EVERY consumer (filters, labels, the
  // status dropdown) sees the new status instantly — this replaced a
  // router.refresh() that re-ran the whole inbox page (~8 DB queries) on
  // every single status change.
  const [statusOverrides, setStatusOverrides] = useState<
    Record<
      string,
      {
        status: LeadStatus
        statusDetail: NotLiquidReason | null
        statusManual: boolean
      }
    >
  >({})

  // Drop a status override once the server catches up (fresh props carry the
  // same status) so stale overrides can never mask NEWER server-side changes.
  useEffect(() => {
    // Returns the same reference when nothing changed — no cascading renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatusOverrides((prev) => {
      const ids = Object.keys(prev)
      if (ids.length === 0) return prev
      let changed = false
      const next = { ...prev }
      for (const id of ids) {
        const server = rawConversations.find((c) => c.id === id)
        if (
          server &&
          server.status === prev[id].status &&
          (server.statusDetail ?? null) === prev[id].statusDetail
        ) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [rawConversations])

  // Hide foreign account names: blank the channel name for any lead whose
  // channel this manager doesn't own, so the other account stays invisible.
  const conversations = useMemo(() => {
    const owned = ownedChannelIds.length > 0 ? new Set(ownedChannelIds) : null
    const hasStatusOverrides = Object.keys(statusOverrides).length > 0
    if (!owned && !hasStatusOverrides) return rawConversations
    return rawConversations.map((c) => {
      let next = c
      if (owned && !owned.has(c.channelId)) {
        next = { ...next, channelName: undefined }
      }
      const so = statusOverrides[c.id]
      if (so) {
        next = {
          ...next,
          status: so.status,
          statusDetail: so.statusDetail ?? undefined,
          statusManual: so.statusManual,
        }
      }
      return next
    })
  }, [rawConversations, ownedChannelIds, statusOverrides])

  // Optimistic "no reply needed" dismissals (conversationId -> dismissal time
  // in ms). Lets the badge/sorting update instantly before the server
  // round-trip; merged with the persisted `replyDismissedAt` from the server.
  const [dismissedOverrides, setDismissedOverrides] = useState<
    Record<string, number>
  >({})

  // Optimistic mute overrides (conversationId -> muted) so muting/unmuting
  // reflects instantly. Merged with the persisted `muted` flag from the server.
  const [mutedOverrides, setMutedOverrides] = useState<
    Record<string, boolean>
  >({})

  // Optimistic per-conversation AI-lead state, keyed by conversation id.
  const [aiOverrides, setAiOverrides] = useState<Record<string, boolean>>({})

  // Effective mute state: optimistic override wins, else the persisted flag.
  const isMuted = useCallback(
    (c: Conversation) => mutedOverrides[c.id] ?? Boolean(c.muted),
    [mutedOverrides],
  )

  // `optionValue` is either 'auto', a plain status, or 'not_liquid:<reason>'.
  const changeStatus = useCallback(
    (conversationId: string, optionValue: string) => {
      let status: LeadStatus | 'auto' = 'auto'
      let reason: NotLiquidReason | null = null
      if (optionValue !== 'auto') {
        const opt = LEAD_STATUS_OPTIONS.find((o) => o.value === optionValue)
        if (opt) {
          status = opt.status
          reason = opt.reason ?? null
        } else {
          status = optionValue as LeadStatus
        }
      }
      // Optimistic: manual statuses update instantly through statusOverrides.
      // 'auto' means the SERVER recomputes the status — we can't know the
      // result client-side, so that (rare) branch still refreshes.
      let prevOverride:
        | { status: LeadStatus; statusDetail: NotLiquidReason | null; statusManual: boolean }
        | undefined
      if (status !== 'auto') {
        setStatusOverrides((prev) => {
          prevOverride = prev[conversationId]
          return {
            ...prev,
            [conversationId]: {
              status: status as LeadStatus,
              statusDetail: reason,
              statusManual: true,
            },
          }
        })
      }
      startStatusTransition(async () => {
        const res = await setLeadStatusAction(conversationId, status, reason)
        if (!res.ok) {
          toast.error(res.message)
          // Roll back the optimistic status on failure.
          if (status !== 'auto') {
            setStatusOverrides((prev) => {
              const next = { ...prev }
              if (prevOverride) next[conversationId] = prevOverride
              else delete next[conversationId]
              return next
            })
          }
          return
        }
        toast.success(res.message)
        if (status === 'auto') router.refresh()
      })
    },
    [router],
  )

  // Mark a thread as "no reply needed" (or restore it). Optimistically stamps
  // the local override so badge/sorting/reminders update instantly, then
  // persists.
  const dismissReply = useCallback(
    (conversationId: string, clear = false) => {
      setDismissedOverrides((prev) => {
        const next = { ...prev }
        if (clear) delete next[conversationId]
        else next[conversationId] = Date.now()
        return next
      })
      // Don't nag again about a thread we just dismissed.
      snoozeReminderRef.current(conversationId)
      startStatusTransition(async () => {
        const res = await dismissReplyReminderAction(conversationId, clear)
        if (!res.ok) {
          toast.error(res.message)
          // Roll back the optimistic override on failure.
          setDismissedOverrides((prev) => {
            const next = { ...prev }
            delete next[conversationId]
            return next
          })
          return
        }
        toast.success(res.message)
        // No router.refresh(): the dismissedOverrides map already drives the
        // badge/sorting, and the server flag arrives with the next sync.
      })
    },
    [snoozeReminderRef],
  )

  // Mute (silence) or unmute a contact, optimistically. Muted threads send no
  // notifications and are hidden from the default list.
  const toggleMute = useCallback(
    (conversationId: string, muted: boolean) => {
      setMutedOverrides((prev) => ({ ...prev, [conversationId]: muted }))
      if (muted) snoozeReminderRef.current(conversationId)
      startStatusTransition(async () => {
        const res = await setConversationMutedAction(conversationId, muted)
        if (!res.ok) {
          toast.error(res.message)
          // Roll back the optimistic override on failure.
          setMutedOverrides((prev) => {
            const next = { ...prev }
            delete next[conversationId]
            return next
          })
          return
        }
        toast.success(res.message)
        // No router.refresh(): mutedOverrides already covers every consumer.
      })
    },
    [snoozeReminderRef],
  )

  // Turn the AI manager-assistant on/off for a conversation. When it's
  // switched on, the assistant re-reads the thread and leads from the next
  // inbound message; a manual manager reply flips it back off server-side.
  const toggleAi = useCallback((conversationId: string, enabled: boolean) => {
    setAiOverrides((prev) => ({ ...prev, [conversationId]: enabled }))
    startStatusTransition(async () => {
      const res = await toggleConversationAiAction(conversationId, enabled)
      if (!res.ok) {
        toast.error(res.message)
        setAiOverrides((prev) => {
          const next = { ...prev }
          delete next[conversationId]
          return next
        })
        return
      }
      toast.success(res.message)
      // No router.refresh(): aiOverrides already drives the composer state.
    })
  }, [])

  return {
    conversations,
    statusPending,
    startStatusTransition,
    dismissedOverrides,
    mutedOverrides,
    aiOverrides,
    isMuted,
    changeStatus,
    dismissReply,
    toggleMute,
    toggleAi,
  }
}
