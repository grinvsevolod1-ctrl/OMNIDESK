'use server'

import {
  revalidatePath,
} from 'next/cache'
import {
  requireAdmin,
} from '@/lib/auth'
import {
  query,
} from '@/lib/db'
import {
  adminReassignConversations,
  getConversationAdmin,
  listConversationsAdmin,
  listMessagesAdmin,
  updateManagerStatus,
} from '@/lib/data'
import {
  getThreadSimInfoOne,
  getThreadsSimInfo,
  type ThreadSimInfo,
} from '@/lib/client-sim/store'
import {
  type ChannelType,
  type Conversation,
  type ManagerStatus,
  type Message,
} from '@/lib/types'
import {
  ADMIN_PATH,
  audit,
  type ActionResult,
} from './shared'

export async function secretSetManagerStatusAction(
  id: string,
  status: string,
): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!id || (status !== 'active' && status !== 'blocked'))
    return { ok: false, message: 'Некорректный статус менеджера' }
  await updateManagerStatus(id, status as ManagerStatus)
  audit(admin, status === 'blocked' ? 'manager.block' : 'manager.unblock', {
    targetId: id,
    detail: { status },
  })
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: status === 'blocked' ? 'Менеджер заблокирован' : 'Менеджер разблокирован',
  }
}

/* ===================================================================== */
/*  God-mode conversation hand-off (manager → manager)                   */
/* ===================================================================== */

export interface ReassignConversation {
  id: string
  contactName: string
  channelType: ChannelType
  channelName: string | null
  lastMessage: string
  lastMessageAt: string
  unread: number
}

/**
 * Every conversation owned by a given manager, newest activity first. Powers the
 * source-side list of the "Передача" (hand-off) tab. Admin-wide: re-checks
 * requireAdmin and is not scoped to the caller.
 */
export async function secretListManagerConversationsAction(
  managerId: string,
): Promise<ReassignConversation[]> {
  await requireAdmin()
  if (!managerId) return []
  const rows = await query<{
    id: string
    contact_name: string
    channel_type: ChannelType
    channel_name: string | null
    last_message: string
    last_message_at: string
    unread: number
  }>(
    `SELECT c.id, c.contact_name, c.channel_type,
            ch.name AS channel_name, c.last_message, c.last_message_at, c.unread
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.manager_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT 500`,
    [managerId],
  )
  return rows.map((r) => ({
    id: r.id,
    contactName: r.contact_name,
    channelType: r.channel_type,
    channelName: r.channel_name,
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at,
    unread: r.unread,
  }))
}

/**
 * Move a batch of conversations to another manager. Validates the target and
 * funnels through adminReassignConversations (audit trail + realtime notify).
 */
export async function secretReassignConversationsAction(input: {
  conversationIds: string[]
  toManagerId: string
}): Promise<ActionResult> {
  const admin = await requireAdmin()
  const ids = (input.conversationIds ?? []).filter(Boolean)
  if (ids.length === 0)
    return { ok: false, message: 'Не выбрано ни одного диалога' }
  if (!input.toManagerId)
    return { ok: false, message: 'Не выбран получатель' }

  const moved = await adminReassignConversations({
    conversationIds: ids,
    toManagerId: input.toManagerId,
  })
  audit(admin, 'conversation.reassign', {
    targetId: input.toManagerId,
    summary: `Передано диалогов: ${moved}`,
    detail: { toManagerId: input.toManagerId, conversationIds: ids, moved },
  })
  revalidatePath(ADMIN_PATH)
  if (moved === 0)
    return {
      ok: false,
      message: 'Ничего не передано (диалоги уже у выбранного менеджера)',
    }
  return {
    ok: true,
    message: `Передано диалогов: ${moved}`,
  }
}

/* ===================================================================== */
/*  God-mode Conversation Console                                        */
/*  These power the live two-pane console where the admin impersonates   */
/*  the CLIENT (inbound messages) to talk to their own managers. Every   */
/*  insert goes through the same `messages`/`conversations` tables whose */
/*  triggers fire pg_notify('realtime', …) — so a message written here   */
/*  lands in the target manager's real inbox live, exactly like a genuine*/
/*  incoming message would.                                              */
/* ===================================================================== */

export type ConversationWithManager = Conversation & { managerName: string | null }

/**
 * God-console-only view model: a conversation plus the simulator's involvement
 * in it. `sim` is null for ordinary (non-simulated) conversations. This type is
 * deliberately local to the god console — the shared `Conversation`/data layer
 * is never widened, so nothing about the simulator can leak into the manager
 * inbox or the regular admin surface.
 */
export type ConversationWithSim = ConversationWithManager & {
  sim: ThreadSimInfo | null
}

/** Live-searchable list of every conversation (admin-wide, no manager scope). */
export async function secretListConversationsAction(opts?: {
  search?: string
  channelType?: string
}): Promise<ConversationWithSim[]> {
  await requireAdmin()
  const channelType =
    opts?.channelType && opts.channelType !== 'all'
      ? (opts.channelType as ChannelType)
      : undefined
  const list = await listConversationsAdmin({ search: opts?.search, channelType })
  const simInfo = await getThreadsSimInfo(list.map((c) => c.id))
  return list.map((c) => ({ ...c, sim: simInfo.get(c.id) ?? null }))
}

export interface ThreadResult {
  ok: boolean
  message?: string
  conversation: ConversationWithManager | null
  messages: Message[]
  /** Simulator involvement for this conversation (null when not simulated). */
  sim: ThreadSimInfo | null
}

/** Full transcript + metadata for one conversation (admin-wide). */
export async function secretFetchThreadAction(
  conversationId: string,
): Promise<ThreadResult> {
  await requireAdmin()
  if (!conversationId)
    return { ok: false, message: 'Не указан диалог', conversation: null, messages: [], sim: null }
  const conversation = await getConversationAdmin(conversationId)
  if (!conversation)
    return { ok: false, message: 'Диалог не найден', conversation: null, messages: [], sim: null }
  const messages = await listMessagesAdmin(conversationId)
  const sim = await getThreadSimInfoOne(conversationId)
  return { ok: true, conversation, messages, sim }
}
