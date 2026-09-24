/**
 * Данные раздела «Диалоги» руководителя (/head/chats): переписка кураторов
 * его команд(ы) с кандидатами — СТРОГО ТОЛЬКО ЧТЕНИЕ.
 *
 * Скоуп каждого запроса — `conversations.curator_id` ∈ кураторы команд
 * руководителя (managers.team_id → teams.head_id). Это зеркало
 * curator-conversations.ts с другим владельцем: руководитель не отправляет,
 * не правит, не удаляет и не отмечает прочитанным — здесь нет ни одной
 * пишущей функции, и добавлять их сюда не нужно (этап 1 — только просмотр).
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

/** Кураторы команд руководителя ($1 = head id). */
const HEAD_CURATORS = `(SELECT m.id FROM managers m
      WHERE m.role = 'curator'
        AND m.team_id IN (SELECT t.id FROM teams t WHERE t.head_id = $1))`

/** Те же потолки, что у кураторского инбокса. */
const HEAD_CONVERSATION_LIMIT = 500
const MESSAGE_HISTORY_LIMIT = 300
const BATCH_PRELOAD_LIMIT = 30

type HeadConversationRow = ConversationRow & {
  channel_name: string | null
  manager_name: string | null
  curator_name: string | null
}

function toHeadConversation(r: HeadConversationRow): Conversation {
  return {
    ...toConversation(r),
    channelName: r.channel_name ?? undefined,
    managerName: r.manager_name ?? undefined,
    curatorId: r.curator_id ?? undefined,
    curatorName: r.curator_name ?? undefined,
  }
}

/**
 * Диалоги кураторов руководителя, свежие сверху. `curatorId` сужает выборку
 * до одного куратора — но ТОЛЬКО если он входит в команду руководителя
 * (пересечение со скоупом, чужой id даёт пустой список, а не утечку).
 */
export async function listConversationsForHead(
  headId: string,
  curatorId?: string | null,
): Promise<Conversation[]> {
  const rows = await query<HeadConversationRow>(
    `SELECT ${conversationColumns('c')}, ch.name AS channel_name,
            m.name AS manager_name, cur.name AS curator_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN managers m ON m.id = c.manager_id
       LEFT JOIN managers cur ON cur.id = c.curator_id
      WHERE c.curator_id IN ${HEAD_CURATORS}
        AND ($2::uuid IS NULL OR c.curator_id = $2::uuid)
        -- Мягко удалённый лид (корзина админа) прячет диалог и у руководителя.
        AND NOT EXISTS (
          SELECT 1 FROM lead_cards lc
           WHERE lc.conversation_id = c.id AND lc.deleted_at IS NOT NULL
        )
      ORDER BY c.last_message_at DESC
      LIMIT $3`,
    [headId, curatorId || null, HEAD_CONVERSATION_LIMIT],
  )
  return rows.map(toHeadConversation)
}

/** Один диалог в скоупе руководителя (защита от IDOR). */
export async function getConversationForHead(
  conversationId: string,
  headId: string,
): Promise<Conversation | null> {
  const rows = await query<HeadConversationRow>(
    `SELECT ${conversationColumns('c')}, ch.name AS channel_name,
            m.name AS manager_name, cur.name AS curator_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN managers m ON m.id = c.manager_id
       LEFT JOIN managers cur ON cur.id = c.curator_id
      WHERE c.id = $2 AND c.curator_id IN ${HEAD_CURATORS}
      LIMIT 1`,
    [headId, conversationId],
  )
  return rows[0] ? toHeadConversation(rows[0]) : null
}

/** История одного диалога (новейшие → разворот в хронологию), скоуп руководителя. */
export async function listMessagesForHead(
  conversationId: string,
  headId: string,
): Promise<Message[]> {
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       ${MESSAGE_REPLY_JOIN}
      WHERE m.conversation_id = $2 AND c.curator_id IN ${HEAD_CURATORS}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    [headId, conversationId, MESSAGE_HISTORY_LIMIT],
  )
  return rows.reverse().map(toMessage)
}

/** Батч-предзагрузка последних сообщений для нескольких диалогов (скоуп руководителя). */
export async function listMessagesForConversationsHead(
  conversationIds: string[],
  headId: string,
): Promise<Record<string, Message[]>> {
  const byId: Record<string, Message[]> = {}
  if (conversationIds.length === 0) return byId
  const rows = await query<MessageRow & { rn: number }>(
    `SELECT id, conversation_id, direction, body, author, created_at,
            media_type, media_mime, media_name, reactions, deleted_at,
            deleted_origin, status, error_reason, edited_at, edit_count,
            reply_to_id, reply_to_author, reply_to_body, reply_to_media_type
       FROM (
         SELECT ${MESSAGE_SELECT},
                ROW_NUMBER() OVER (
                  PARTITION BY m.conversation_id
                  ORDER BY m.created_at DESC, m.id DESC
                ) AS rn
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           ${MESSAGE_REPLY_JOIN}
          WHERE c.curator_id IN ${HEAD_CURATORS}
            AND m.conversation_id = ANY($2)
       ) ranked
      WHERE rn <= $3
      ORDER BY conversation_id ASC, created_at ASC, id ASC`,
    [headId, conversationIds, BATCH_PRELOAD_LIMIT],
  )
  for (const row of rows) {
    const list = byId[row.conversation_id] ?? (byId[row.conversation_id] = [])
    list.push(toMessage(row))
  }
  return byId
}

/** Подгрузка более старой истории (пагинация вверх), скоуп руководителя. */
export async function listMessagesBeforeForHead(
  conversationId: string,
  headId: string,
  before: string,
  limit = MESSAGE_HISTORY_LIMIT,
): Promise<Message[]> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), MESSAGE_HISTORY_LIMIT)
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       ${MESSAGE_REPLY_JOIN}
      WHERE m.conversation_id = $2
        AND c.curator_id IN ${HEAD_CURATORS}
        AND m.created_at < $3
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $4`,
    [headId, conversationId, before, capped],
  )
  return rows.reverse().map(toMessage)
}

/**
 * Владение медиа для `/api/media/{id}` в сессии руководителя: сообщение
 * принадлежит диалогу, переданному куратору из его команды. Денормализованные
 * channel_id / channel_type с conversations — как у остальных getMessageOwner*
 * (INNER JOIN channels 404-ил бы архивные фото после переподключения канала).
 */
export async function getMessageOwnerForHead(
  messageId: string,
  headId: string,
): Promise<{ channelId: string; channelType: ChannelType } | null> {
  const rows = await query<{ channel_id: string; channel_type: ChannelType }>(
    `SELECT c.channel_id, c.channel_type
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $2 AND c.curator_id IN ${HEAD_CURATORS}`,
    [headId, messageId],
  )
  if (rows.length === 0) return null
  return { channelId: rows[0].channel_id, channelType: rows[0].channel_type }
}
