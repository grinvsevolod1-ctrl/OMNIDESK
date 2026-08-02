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
  clearManagerTempPassword,
  getConversationAdmin,
  getManagerById,
  getManagerTempPassword,
  listConversationsAdmin,
  listMessagesAdmin,
  setManagerTempPassword,
  updateManagerStatus,
} from '@/lib/data'
import { generatePassword } from '@/lib/crypto'
import {
  type ChannelType,
  type Conversation,
  type ManagerStatus,
  type Message,
} from '@/lib/types'
import {
  ADMIN_PATH,
  assertConsoleOrMessenger,
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
/*  God-mode temporary passwords                                         */
/* ===================================================================== */

export interface TempPasswordResult extends ActionResult {
  /** Present on success: the current temp password (null when cleared/none). */
  password?: string | null
  /** ISO timestamp of when it was set, or null. */
  setAt?: string | null
}

function toIso(v: string | Date | null): string | null {
  if (!v) return null
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

/**
 * Reveal a manager's temporary password (decrypted) for display in the God
 * panel. Read-only; does not create one if absent.
 */
export async function secretRevealManagerTempPasswordAction(
  managerId: string,
): Promise<TempPasswordResult> {
  const admin = await requireAdmin()
  if (!managerId) return { ok: false, message: 'Не указан менеджер' }
  const manager = await getManagerById(managerId)
  if (!manager) return { ok: false, message: 'Менеджер не найден' }
  const { password, setAt } = await getManagerTempPassword(managerId)
  audit(admin, 'manager.temp_password.reveal', { targetId: managerId })
  return {
    ok: true,
    message: password ? 'Пароль показан' : 'Временный пароль не задан',
    password,
    setAt: toIso(setAt),
  }
}

/**
 * Set or replace a manager's temporary password. When `password` is omitted a
 * strong one is generated. Returns the plaintext so the panel can show/copy it.
 * Independent of the main password — existing sessions are NOT invalidated.
 */
export async function secretSetManagerTempPasswordAction(input: {
  managerId: string
  password?: string
}): Promise<TempPasswordResult> {
  const admin = await requireAdmin()
  const { managerId } = input
  if (!managerId) return { ok: false, message: 'Не указан менеджер' }
  const manager = await getManagerById(managerId)
  if (!manager) return { ok: false, message: 'Менеджер не найден' }

  const custom = (input.password ?? '').trim()
  if (custom && custom.length < 6)
    return { ok: false, message: 'Минимальная длина пароля — 6 символов' }
  const password = custom || generatePassword(16)

  await setManagerTempPassword(managerId, password)
  audit(admin, 'manager.temp_password.set', {
    targetId: managerId,
    detail: { generated: !custom },
  })
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: custom ? 'Временный пароль сохранён' : 'Временный пароль сгенерирован',
    password,
    setAt: new Date().toISOString(),
  }
}

/** Remove a manager's temporary password (their main password is untouched). */
export async function secretClearManagerTempPasswordAction(
  managerId: string,
): Promise<TempPasswordResult> {
  const admin = await requireAdmin()
  if (!managerId) return { ok: false, message: 'Не указан менеджер' }
  const manager = await getManagerById(managerId)
  if (!manager) return { ok: false, message: 'Менеджер не найден' }
  await clearManagerTempPassword(managerId)
  audit(admin, 'manager.temp_password.clear', { targetId: managerId })
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Временный пароль удалён', password: null, setAt: null }
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

export type ConversationWithManager = Conversation & {
  managerName: string | null
  /**
   * Messages FROM the manager that the god user hasn't seen yet
   * (direction='out' newer than conversations.god_read_at). This is the
   * counter the chat list highlights — NOT `unread`, which counts what the
   * MANAGER hasn't read.
   */
  godUnread?: number
}

/** Live-searchable list of every conversation (admin-wide, no manager scope). */
export async function secretListConversationsAction(opts?: {
  search?: string
  channelType?: string
}): Promise<ConversationWithManager[]> {
  await assertConsoleOrMessenger()
  const channelType =
    opts?.channelType && opts.channelType !== 'all'
      ? (opts.channelType as ChannelType)
      : undefined
  return listConversationsAdmin({ search: opts?.search, channelType })
}

export interface ThreadResult {
  ok: boolean
  message?: string
  conversation: ConversationWithManager | null
  messages: Message[]
}

/** Full transcript + metadata for one conversation (admin-wide). */
export async function secretFetchThreadAction(
  conversationId: string,
): Promise<ThreadResult> {
  await assertConsoleOrMessenger()
  if (!conversationId)
    return { ok: false, message: 'Не указан диалог', conversation: null, messages: [] }
  const conversation = await getConversationAdmin(conversationId)
  if (!conversation)
    return { ok: false, message: 'Диалог не найден', conversation: null, messages: [] }
  const messages = await listMessagesAdmin(conversationId)
  // Opening the thread means the god user has SEEN everything in it — clear
  // the god-side unread marker (manager replies newer than god_read_at).
  await query(`UPDATE conversations SET god_read_at = now() WHERE id = $1`, [
    conversationId,
  ])
  return { ok: true, conversation, messages }
}

/**
 * Lightweight god-side read receipt. Called from the client when a manager
 * message arrives over SSE while the thread is ALREADY open on screen, so the
 * list badge doesn't light up for a dialog the user is actively reading.
 */
export async function secretMarkThreadReadAction(
  conversationId: string,
): Promise<void> {
  await assertConsoleOrMessenger()
  if (!conversationId) return
  await query(`UPDATE conversations SET god_read_at = now() WHERE id = $1`, [
    conversationId,
  ])
}
