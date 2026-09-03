/**
 * Данные для раздела «Чаты» куратора (переданные лиды, миграция 151).
 *
 * Диалог остаётся во владении менеджера (conversations.manager_id), а куратор
 * получает ПАРАЛЛЕЛЬНУЮ ссылку через conversations.curator_id. Поэтому все
 * запросы здесь скоупятся по curator_id — зеркало менеджерских лоадеров из
 * conversations.ts / conversation-messages.ts, но с другим владельцем. Так
 * куратор видит и ведёт только свои переданные диалоги (защита от IDOR), а
 * менеджер продолжает видеть тот же диалог только для чтения.
 */
import { query } from '../db'
import type { Conversation, Message } from '../types'
import { isLeadStatus, type LeadStatus } from '../lead-status'
import {
  conversationColumns,
  MESSAGE_REPLY_JOIN,
  MESSAGE_SELECT,
  toConversation,
  toMessage,
  type ConversationRow,
  type MessageRow,
} from './shared'

/**
 * Кураторский статус диалога = статус его карточки лида. В разделе «Чаты»
 * куратор видит и меняет СВОЙ статус лида прямо из переписки (свой набор
 * статусов, миграция 151), не открывая «Мои лиды». Возвращаем лёгкую пару
 * {leadCardId, status} на каждый диалог — этого достаточно для бейджа и формы
 * подтверждения. Скоуп по curator_id: чужие карточки не утекают.
 */
export interface CuratorConversationStatus {
  leadCardId: string
  status: LeadStatus | null
}

/** Батч: {conversationId → {leadCardId, status}} для диалогов куратора. */
export async function listCuratorLeadStatuses(
  conversationIds: string[],
  curatorId: string,
): Promise<Record<string, CuratorConversationStatus>> {
  const byConversation: Record<string, CuratorConversationStatus> = {}
  if (conversationIds.length === 0) return byConversation
  const rows = await query<{
    conversation_id: string
    id: string
    status: string | null
  }>(
    `SELECT lc.conversation_id, lc.id, lc.status
       FROM lead_cards lc
      WHERE lc.curator_id = $1
        AND lc.conversation_id = ANY($2)`,
    [curatorId, conversationIds],
  )
  for (const row of rows) {
    if (!row.conversation_id) continue
    byConversation[row.conversation_id] = {
      leadCardId: row.id,
      status: isLeadStatus(row.status) ? row.status : null,
    }
  }
  return byConversation
}

/** Тот же потолок, что и у менеджерского инбокса. */
const CURATOR_CONVERSATION_LIMIT = 500
const MESSAGE_HISTORY_LIMIT = 300
const BATCH_PRELOAD_LIMIT = 30

/**
 * Привязать диалог к куратору (передача лида). Ставит curator_id, отметку
 * времени и ПАУЗИТ ИИ (страховка для UI-баннеров; основной гейт — curator_id
 * IS NULL в isConversationAiLed). Идемпотентно перезаписывает при повторной
 * передаче между кураторами. UNSCOPED — вызывается из уже авторизованных путей
 * передачи (менеджер/захват из пула/head), которые сами проверяют права.
 */
export async function linkConversationToCurator(
  conversationId: string,
  curatorId: string,
): Promise<void> {
  await query(
    `UPDATE conversations
        SET curator_id = $2,
            transferred_to_curator_at = now(),
            ai_paused = true
      WHERE id = $1`,
    [conversationId, curatorId],
  )
}

/**
 * Отвязать диалог от куратора (например, лид вернулся в пул). Снимает ссылку и
 * отметку времени; ИИ НЕ размораживаем автоматически — это решение менеджера.
 */
export async function unlinkConversationFromCurator(
  conversationId: string,
): Promise<void> {
  await query(
    `UPDATE conversations
        SET curator_id = NULL,
            transferred_to_curator_at = NULL
      WHERE id = $1`,
    [conversationId],
  )
}

/** Список диалогов куратора (переданные ему лиды), свежие сверху. */
export async function listConversationsForCurator(
  curatorId: string,
): Promise<Conversation[]> {
  const rows = await query<ConversationRow & { channel_name: string | null }>(
    `SELECT ${conversationColumns('c')}, ch.name AS channel_name
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.curator_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT $2`,
    [curatorId, CURATOR_CONVERSATION_LIMIT],
  )
  return rows.map((r) => ({
    ...toConversation(r),
    channelName: r.channel_name ?? undefined,
  }))
}

/** Один диалог куратора со скоупом по curator_id (защита от IDOR). */
export async function getConversationForCurator(
  conversationId: string,
  curatorId: string,
): Promise<Conversation | null> {
  const rows = await query<ConversationRow>(
    `SELECT ${conversationColumns()} FROM conversations
      WHERE id = $1 AND curator_id = $2 LIMIT 1`,
    [conversationId, curatorId],
  )
  return rows[0] ? toConversation(rows[0]) : null
}

/** История одного диалога (новейшие → разворот в хронологию), скоуп куратора. */
export async function listMessagesForCurator(
  conversationId: string,
  curatorId: string,
): Promise<Message[]> {
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       ${MESSAGE_REPLY_JOIN}
      WHERE m.conversation_id = $1 AND c.curator_id = $2
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [conversationId, curatorId, MESSAGE_HISTORY_LIMIT],
  )
  return rows.reverse().map(toMessage)
}

/** Батч-предзагрузка последних сообщений для многих диалогов (скоуп куратора). */
export async function listMessagesForConversationsCurator(
  conversationIds: string[],
  curatorId: string,
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
                  PARTITION BY m.conversation_id ORDER BY m.created_at DESC
                ) AS rn
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           ${MESSAGE_REPLY_JOIN}
          WHERE c.curator_id = $1 AND m.conversation_id = ANY($2)
       ) ranked
      WHERE rn <= $3
      ORDER BY conversation_id ASC, created_at ASC`,
    [curatorId, conversationIds, BATCH_PRELOAD_LIMIT],
  )
  for (const row of rows) {
    const list = byId[row.conversation_id] ?? (byId[row.conversation_id] = [])
    list.push(toMessage(row))
  }
  return byId
}

/** Догрузка более старой истории (пагинация вверх), скоуп куратора. */
export async function listMessagesBeforeForCurator(
  conversationId: string,
  curatorId: string,
  before: string,
  limit = MESSAGE_HISTORY_LIMIT,
): Promise<Message[]> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), MESSAGE_HISTORY_LIMIT)
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       ${MESSAGE_REPLY_JOIN}
      WHERE m.conversation_id = $1 AND c.curator_id = $2 AND m.created_at < $3
      ORDER BY m.created_at DESC
      LIMIT $4`,
    [conversationId, curatorId, before, capped],
  )
  return rows.reverse().map(toMessage)
}

/**
 * Марк «прочитано» для диалога куратора: обнуляет счётчик непрочитанных и
 * штампует read_at на входящих. Возвращает данные для read-receipt (как у
 * менеджера) или null, если диалог не принадлежит куратору.
 */
export async function markCuratorConversationRead(
  conversationId: string,
  curatorId: string,
): Promise<{
  channelId: string
  channelType: Conversation['channelType']
  contactHandle: string
} | null> {
  const rows = await query<{
    channel_id: string
    channel_type: Conversation['channelType']
    contact_handle: string
  }>(
    `UPDATE conversations
        SET unread = 0
      WHERE id = $1 AND curator_id = $2
      RETURNING channel_id, channel_type, contact_handle`,
    [conversationId, curatorId],
  )
  if (!rows[0]) return null
  await query(
    `UPDATE messages
        SET read_at = now()
      WHERE conversation_id = $1 AND direction = 'in' AND read_at IS NULL`,
    [conversationId],
  )
  return {
    channelId: rows[0].channel_id,
    channelType: rows[0].channel_type,
    contactHandle: rows[0].contact_handle,
  }
}
