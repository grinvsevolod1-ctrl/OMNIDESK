'use server'

import { requireAdmin } from '@/lib/auth'
import {
  getConversationAdmin,
  listConversations,
  listMessagesAdmin,
} from '@/lib/data'
import type { Conversation, Message } from '@/lib/types'

/**
 * Admin: list a given manager's conversations so the admin can pick one to read.
 * Returns a lightweight list (no messages) ordered by most recent activity.
 */
export async function adminListManagerConversationsAction(
  managerId: string,
): Promise<Conversation[]> {
  await requireAdmin()
  if (!managerId) return []
  return listConversations(managerId)
}

export interface AdminTranscript {
  conversation: (Conversation & { managerName: string | null }) | null
  messages: Message[]
}

/**
 * Admin: read the full transcript of any conversation. Authorization is enforced
 * here (requireAdmin) since the underlying data helpers are unscoped.
 */
export async function adminGetTranscriptAction(
  conversationId: string,
): Promise<AdminTranscript> {
  await requireAdmin()
  if (!conversationId) return { conversation: null, messages: [] }
  const [conversation, messages] = await Promise.all([
    getConversationAdmin(conversationId),
    listMessagesAdmin(conversationId),
  ])
  return { conversation, messages }
}
