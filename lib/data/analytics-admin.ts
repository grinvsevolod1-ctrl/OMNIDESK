/**
 * Админ-просмотр диалогов и активности менеджеров: карточка диалога с именем
 * менеджера, транскрипт без manager-скоупа, фильтруемый список всех диалогов
 * и сводка активности менеджеров. Выделено из analytics.ts (там re-export).
 *
 * ВНИМАНИЕ: функции здесь НЕ скоупятся по manager_id — только для admin-гейта.
 */
import { query } from '../db'
import type { ChannelType, Conversation, Message } from '../types'
import {
  conversationColumns,
  MESSAGE_REPLY_JOIN,
  MESSAGE_SELECT,
  toConversation,
  toMessage,
  type ConversationRow,
  type MessageRow,
} from './shared'

export async function getConversationAdmin(
  conversationId: string,
): Promise<
  | (Conversation & { managerName: string | null })
  | null
> {
  const rows = await query<
    ConversationRow & {
      channel_name: string | null
      manager_name: string | null
    }
  >(
    `SELECT ${conversationColumns('c')}, ch.name AS channel_name, m.name AS manager_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN managers m ON m.id = c.manager_id
      WHERE c.id = $1
      LIMIT 1`,
    [conversationId],
  )
  if (!rows[0]) return null
  return {
    ...toConversation(rows[0]),
    channelName: rows[0].channel_name ?? undefined,
    managerName: rows[0].manager_name ?? null,
  }
}

export async function listMessagesAdmin(
  conversationId: string,
  opts?: { limit?: number },
): Promise<Message[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000)
  const rows = await query<MessageRow>(
    `SELECT * FROM (
        SELECT ${MESSAGE_SELECT}
          FROM messages m
          ${MESSAGE_REPLY_JOIN}
         WHERE m.conversation_id = $1
         ORDER BY m.created_at DESC
         LIMIT $2
     ) newest
     ORDER BY newest.created_at ASC`,
    [conversationId, limit],
  )
  return rows.map(toMessage)
}

export async function listConversationsAdmin(opts?: {
  search?: string
  channelType?: ChannelType
  managerId?: string
  activeSince?: string
  unansweredOnly?: boolean
  quietSince?: string
  limit?: number
}): Promise<
  Array<Conversation & { managerName: string | null; godUnread: number }>
> {
  const params: unknown[] = []
  const where: string[] = []

  const search = opts?.search?.trim()
  if (search) {
    params.push(`%${search}%`)
    const p = `$${params.length}`
    where.push(
      `(c.contact_name ILIKE ${p} OR c.contact_handle ILIKE ${p} OR c.last_message ILIKE ${p})`,
    )
  }
  if (opts?.channelType) {
    params.push(opts.channelType)
    where.push(`c.channel_type = $${params.length}`)
  }
  if (opts?.managerId) {
    params.push(opts.managerId)
    where.push(`c.manager_id = $${params.length}`)
  }
  if (opts?.activeSince) {
    params.push(opts.activeSince)
    where.push(`c.last_message_at >= $${params.length}`)
  }
  if (opts?.unansweredOnly) {
    where.push(`c.unread > 0`)
  }
  if (opts?.quietSince) {
    params.push(opts.quietSince)
    where.push(`c.last_message_at <= $${params.length}`)
  }

  const limit = Math.min(Math.max(opts?.limit ?? 300, 1), 1000)
  params.push(limit)
  const limitParam = `$${params.length}`

  const rows = await query<
    ConversationRow & {
      channel_name: string | null
      manager_name: string | null
      god_unread: number | string
    }
  >(
    `SELECT ${conversationColumns('c')}, ch.name AS channel_name, m.name AS manager_name,
            (SELECT count(*)
               FROM messages mm
              WHERE mm.conversation_id = c.id
                AND mm.direction = 'out'
                AND mm.created_at > c.god_read_at) AS god_unread
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN managers m ON m.id = c.manager_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.last_message_at DESC
      LIMIT ${limitParam}`,
    params,
  )
  return rows.map((r) => ({
    ...toConversation(r),
    channelName: r.channel_name ?? undefined,
    managerName: r.manager_name ?? null,
    godUnread: Number(r.god_unread),
  }))
}

export interface ManagerActivityRow {
  id: string
  name: string
  status: string
  dialogsTotal: number
  newDialogs: number
  contactsWrote: number
  inboundMessages: number
  unanswered: number
}

export async function listManagerActivity(
  sinceIso: string,
): Promise<ManagerActivityRow[]> {
  const rows = await query<{
    id: string
    name: string
    status: string
    dialogs_total: string | number
    new_dialogs: string | number
    contacts_wrote: string | number
    inbound_messages: string | number
    unanswered: string | number
  }>(
    `SELECT m.id, m.name, m.status,
            (SELECT count(*) FROM conversations c
              WHERE c.manager_id = m.id) AS dialogs_total,
            (SELECT count(*) FROM conversations c
              WHERE c.manager_id = m.id AND c.created_at >= $1) AS new_dialogs,
            (SELECT count(DISTINCT mm.conversation_id)
               FROM messages mm
               JOIN conversations c ON c.id = mm.conversation_id
              WHERE c.manager_id = m.id
                AND mm.direction = 'in'
                AND mm.created_at >= $1) AS contacts_wrote,
            (SELECT count(*)
               FROM messages mm
               JOIN conversations c ON c.id = mm.conversation_id
              WHERE c.manager_id = m.id
                AND mm.direction = 'in'
                AND mm.created_at >= $1) AS inbound_messages,
            (SELECT count(*) FROM conversations c
              WHERE c.manager_id = m.id AND c.unread > 0) AS unanswered
       FROM managers m
      WHERE m.role = 'manager'
      ORDER BY m.name ASC`,
    [sinceIso],
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    dialogsTotal: Number(r.dialogs_total),
    newDialogs: Number(r.new_dialogs),
    contactsWrote: Number(r.contacts_wrote),
    inboundMessages: Number(r.inbound_messages),
    unanswered: Number(r.unanswered),
  }))
}
