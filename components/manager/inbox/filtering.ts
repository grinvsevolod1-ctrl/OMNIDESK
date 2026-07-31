/**
 * Pure conversation list filtering + sorting for the manager inbox, extracted
 * from inbox-view.tsx. Given the raw conversations plus the current search /
 * filter / sort UI state, it returns the visible, ordered list. No React, no
 * side effects — trivially testable and cheap to reason about.
 *
 * Threads that "need attention" (unread, or a read-but-unanswered inbound last
 * message) always float to the top regardless of the chosen sort mode.
 */

import { LEAD_STATUS_ORDER } from '@/lib/types'
import type {
  ChannelType,
  Conversation,
  LeadStatus,
  Message,
  NotLiquidReason,
} from '@/lib/types'
import { sourceLabel, type SortMode } from '@/components/manager/inbox/visual'

export interface FilterSortParams {
  conversations: Conversation[]
  search: string
  typeFilter: Set<ChannelType>
  sourceFilter: Set<string>
  statusFilter: Set<LeadStatus>
  reasonFilter: Set<NotLiquidReason>
  sortMode: SortMode
  awaitingReply: Map<string, { waiting: boolean; since: number }>
  isMuted: (c: Conversation) => boolean
  showMuted: boolean
  activeId: string | null
  localMessages: Record<string, Message[]>
}

export function filterAndSortConversations({
  conversations,
  search,
  typeFilter,
  sourceFilter,
  statusFilter,
  reasonFilter,
  sortMode,
  awaitingReply,
  isMuted,
  showMuted,
  activeId,
  localMessages,
}: FilterSortParams): Conversation[] {
  const q = search.trim().toLowerCase()
  const list = conversations.filter((c) => {
    // Muted contacts are hidden by default; reveal them via the toggle. The
    // currently-open thread always stays visible so it never vanishes mid-chat.
    if (isMuted(c) && !showMuted && c.id !== activeId) return false
    if (typeFilter.size > 0 && !typeFilter.has(c.channelType)) return false
    if (sourceFilter.size > 0 && !sourceFilter.has(c.channelId)) return false
    if (statusFilter.size > 0 && !statusFilter.has(c.status)) return false
    if (
      reasonFilter.size > 0 &&
      (c.status !== 'not_liquid' ||
        !c.statusDetail ||
        !reasonFilter.has(c.statusDetail))
    )
      return false
    if (!q) return true
    // Match on contact/source metadata first (cheap), then fall back to a
    // full-text scan of every message we've loaded for this thread so search
    // covers the whole conversation history, not just the last message.
    if (
      c.contactName.toLowerCase().includes(q) ||
      c.lastMessage.toLowerCase().includes(q) ||
      sourceLabel(c).toLowerCase().includes(q)
    ) {
      return true
    }
    const msgs = localMessages[c.id]
    return msgs ? msgs.some((m) => m.body?.toLowerCase().includes(q)) : false
  })
  const byRecent = (a: Conversation, b: Conversation) => {
    const timeDelta =
      new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    if (timeDelta !== 0) return timeDelta
    return a.id.localeCompare(b.id)
  }
  const statusRank = (c: Conversation) => LEAD_STATUS_ORDER.indexOf(c.status)
  // A thread "needs attention" when it has unread messages OR its last message
  // is inbound (read but not yet answered). These always float to the very top,
  // regardless of the chosen sort mode, so managers can't miss them.
  const needsAttention = (c: Conversation) =>
    c.unread > 0 || (awaitingReply.get(c.id)?.waiting ?? false)
  return [...list].sort((a, b) => {
    const attnDelta = (needsAttention(b) ? 1 : 0) - (needsAttention(a) ? 1 : 0)
    if (attnDelta !== 0) return attnDelta
    switch (sortMode) {
      case 'oldest':
        return (
          new Date(a.lastMessageAt).getTime() -
            new Date(b.lastMessageAt).getTime() || a.id.localeCompare(b.id)
        )
      case 'unread': {
        const d = b.unread - a.unread
        return d !== 0 ? d : byRecent(a, b)
      }
      case 'status': {
        const d = statusRank(a) - statusRank(b)
        return d !== 0 ? d : byRecent(a, b)
      }
      case 'recent':
      default:
        return byRecent(a, b)
    }
  })
}
