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
import { isReworkStatus } from '@/lib/lead-status'
import { sourceLabel, type SortMode } from '@/components/manager/inbox/visual'

/**
 * Which manager "bucket" a conversation belongs to, derived purely from
 * whether it's been handed to a curator and that curator's lead-card status:
 *
 *   'active'      — not transferred (curator_id NULL). Normal thread the
 *                   manager (or AI) leads.
 *   'transferred' — handed to a curator who is actively working it. The
 *                   manager may only READ it.
 *   'rework'      — the curator gave up on it (Игнор/Отказался/Не связался) or
 *                   archived it, so it came BACK to the manager for a follow-up
 *                   push. Composer enabled; also surfaced under «Доработки».
 *   'archived'    — came back and the manager sent it «в trash». Leaves the
 *                   default list and «Доработки», but stays writable: the lead
 *                   was returned, trash is just list hygiene.
 *
 * Every non-'active' bucket carries the system status «Передан» (migration
 * 161), so the «Статусы → Передан» filter is the single place that reveals all
 * of them — archived, trashed or not. Whether the manager can write is decided
 * here: only 'transferred' is read-only (see canManagerWrite).
 *
 * Single source of truth shared by the list filter, the counters and the open
 * thread, so all three always agree.
 */
export type ManagerBucket = 'active' | 'transferred' | 'rework' | 'archived'

export function managerBucket(c: Conversation): ManagerBucket {
  if (!c.transferred) return 'active'
  const rework = c.curatorArchived || isReworkStatus(c.curatorLeadStatus)
  if (rework) return c.curatorReworkTrashed ? 'archived' : 'rework'
  return 'transferred'
}

/**
 * May the manager write into this thread? Only while the curator is actively
 * working it the answer is no — once the lead came back (rework or trashed)
 * the manager is the one who talks to the client again.
 */
export function canManagerWrite(c: Conversation): boolean {
  return managerBucket(c) !== 'transferred'
}

/**
 * The two list views a manager can switch between. 'active' is the default
 * inbox; 'rework' («Доработки») narrows it to leads the curator gave back.
 * There is deliberately NO 'transferred' view — that is what the «Передан»
 * status filter is for.
 */
export type InboxView = 'active' | 'rework'

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
  /**
   * Which view the manager is in. 'active' (default) shows threads the manager
   * leads and hides everything handed to a curator unless the «Передан» status
   * is picked in the status filter; 'rework' shows only «Доработки».
   */
  viewBucket: InboxView
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
  viewBucket,
  activeId,
  localMessages,
}: FilterSortParams): Conversation[] {
  const q = search.trim().toLowerCase()
  // Picking «Передан» in the status filter is THE way to see transferred
  // threads — all of them, whatever the curator or the manager did with the
  // lead card afterwards (archive, trash). Without it the default view stays
  // focused on threads the manager actually leads.
  const revealTransferred = statusFilter.has('transferred')
  const list = conversations.filter((c) => {
    // View gate. The open thread is exempt so it never vanishes mid-read
    // (e.g. the curator picks it up while the manager has it open).
    const bucket = managerBucket(c)
    if (c.id !== activeId) {
      if (viewBucket === 'rework') {
        if (bucket !== 'rework') return false
      } else if (bucket !== 'active' && !revealTransferred) {
        return false
      }
    }
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
