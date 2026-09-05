'use client'

import { useMemo } from 'react'
import type { ForwardTarget } from '@/components/manager/message-context-menu'
import { sourceLabel } from '@/components/manager/inbox/visual'
import { managerBucket } from '@/components/manager/inbox/filtering'
import type {
  ChannelType,
  Conversation,
  LeadStatus,
  Message,
  NotLiquidReason,
  PanelChannelType,
} from '@/lib/types'

/**
 * Производные данные списка диалогов: счётчики по типам/статусам/причинам,
 * источники, «ждёт ответа», непрочитанные, цели пересылки. Чистые useMemo,
 * вынесенные из inbox-view.
 */
export function useInboxDerived({
  conversations,
  localMessages,
  dismissedOverrides,
  mutedOverrides,
  typeFilter,
  ownedChannelIds,
  isMuted,
  activeId,
}: {
  conversations: Conversation[]
  localMessages: Record<string, Message[]>
  dismissedOverrides: Record<string, number>
  mutedOverrides: Record<string, boolean>
  typeFilter: Set<ChannelType>
  ownedChannelIds: string[]
  isMuted: (c: Conversation) => boolean
  activeId: string | null
}) {
  const typeCounts = useMemo(() => {
    // PanelChannelType: personal-каналов в инбоксе менеджера не бывает
    // (worker их не ingest'ит), но страховка ??= 0 не даст NaN при мусоре.
    const counts: Record<PanelChannelType, number> = {
      telegram: 0,
      whatsapp: 0,
      livechat: 0,
      max: 0,
      vk: 0,
    }
    for (const c of conversations) {
      counts[c.channelType as PanelChannelType] ??= 0
      counts[c.channelType as PanelChannelType] += 1
    }
    return counts as Record<ChannelType, number>
  }, [conversations])

  const statusCounts = useMemo(() => {
    const counts: Record<LeadStatus, number> = {
      unsubscribed: 0,
      handoff: 0,
      liquid: 0,
      not_liquid: 0,
      transferred: 0,
    }
    for (const c of conversations) counts[c.status] += 1
    return counts
  }, [conversations])

  const reasonCounts = useMemo(() => {
    const counts: Record<NotLiquidReason, number> = {
      geo: 0,
      under18: 0,
      na: 0,
      trash: 0,
    }
    for (const c of conversations) {
      if (c.status === 'not_liquid' && c.statusDetail)
        counts[c.statusDetail] += 1
    }
    return counts
  }, [conversations])

  const sources = useMemo(() => {
    const owned = ownedChannelIds.length > 0 ? new Set(ownedChannelIds) : null
    const map = new Map<
      string,
      { id: string; label: string; type: ChannelType; count: number }
    >()
    for (const c of conversations) {
      if (typeFilter.size > 0 && !typeFilter.has(c.channelType)) continue
      // Only the manager's own accounts are sortable sources; leads routed in
      // from a foreign/pool account stay as ordinary leads (no source entry).
      if (owned && !owned.has(c.channelId)) continue
      const existing = map.get(c.channelId)
      if (existing) existing.count += 1
      else
        map.set(c.channelId, {
          id: c.channelId,
          label: sourceLabel(c),
          type: c.channelType,
          count: 1,
        })
    }
    return Array.from(map.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    )
  }, [conversations, typeFilter, ownedChannelIds])

  // For each conversation, work out whether it is still awaiting a manager
  // reply (the last message is inbound) and since when. Falls back to the
  // unread counter when a thread's messages aren't cached yet. Drives both the
  // "unread/unanswered on top" sorting and the "you haven't replied" reminder.
  const awaitingReply = useMemo(() => {
    const map = new Map<string, { waiting: boolean; since: number }>()
    for (const c of conversations) {
      const msgs = localMessages[c.id]
      let waiting: boolean
      let since: number
      if (msgs && msgs.length > 0) {
        const last = msgs[msgs.length - 1]
        waiting = last.direction === 'in'
        since = new Date(last.createdAt).getTime()
      } else {
        waiting = c.unread > 0
        since = new Date(c.lastMessageAt).getTime()
      }
      // A manual "no reply needed" dismissal silences the thread until a newer
      // inbound message arrives (since > dismissedAt reactivates it). Take the
      // max of the optimistic override and the persisted server timestamp.
      if (waiting) {
        const dismissedAt = Math.max(
          dismissedOverrides[c.id] ?? 0,
          c.replyDismissedAt ? new Date(c.replyDismissedAt).getTime() : 0,
        )
        if (dismissedAt >= since) waiting = false
      }
      // Muted contacts never count as awaiting a reply (no badge, no reminder).
      if (mutedOverrides[c.id] ?? Boolean(c.muted)) waiting = false
      map.set(c.id, { waiting, since })
    }
    return map
  }, [conversations, localMessages, dismissedOverrides, mutedOverrides])

  // How many muted threads exist (drives the "show silenced" toggle).
  const mutedCount = useMemo(
    () => conversations.filter((c) => isMuted(c)).length,
    [conversations, isMuted],
  )

  // Threads a curator is actively working (hidden from the default list) —
  // drives the «Переданные» segment chip.
  const transferredCount = useMemo(
    () =>
      conversations.filter((c) => managerBucket(c) === 'transferred').length,
    [conversations],
  )

  const unreadTotal = useMemo(
    () => conversations.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0),
    [conversations],
  )

  // Other Telegram conversations a message can be forwarded into.
  const forwardTargets: ForwardTarget[] = useMemo(
    () =>
      conversations
        .filter((c) => c.channelType === 'telegram' && c.id !== activeId)
        .map((c) => ({ id: c.id, name: c.contactName })),
    [conversations, activeId],
  )

  // Leads the AI just judged ready and handed off to a human («Ликвид»).
  // Drives the inbox banner + list highlight until each thread is opened.
  const pendingHandoffs = useMemo(
    () => conversations.filter((c) => c.aiHandoffPending && c.id !== activeId),
    [conversations, activeId],
  )

  return {
    typeCounts,
    statusCounts,
    reasonCounts,
    sources,
    awaitingReply,
    mutedCount,
    transferredCount,
    unreadTotal,
    forwardTargets,
    pendingHandoffs,
  }
}
