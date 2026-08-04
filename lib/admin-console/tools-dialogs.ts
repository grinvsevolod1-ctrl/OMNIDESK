import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  getConversationAdmin,
  getManagerById,
  listConversationsAdmin,
  listManagerActivity,
  listMessagesAdmin,
} from '@/lib/data'
import type { ChannelType } from '@/lib/types'
import { truncate, type RunState } from './run-state'

/**
 * Dialog/conversation tools: the copilot's window into the actual message
 * traffic — who wrote, to which manager, what was said. All queries are
 * admin-scoped (no manager filter enforced) because the shell IS the admin.
 * Bulk reassignment is guarded behind a pending confirmation.
 */

const PERIODS = ['today', 'week', 'month', 'all'] as const

function periodStart(period: (typeof PERIODS)[number]): string | undefined {
  const now = new Date()
  switch (period) {
    case 'today': {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      return d.toISOString()
    }
    case 'week':
      return new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()
    case 'month':
      return new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString()
    default:
      return undefined
  }
}

export function dialogTools(state: RunState) {
  return {
    list_dialogs: tool({
      description:
        'Список диалогов (переписок с клиентами) по всей системе. Фильтры: managerId (диалоги конкретного менеджера), channelType (telegram/whatsapp/max/vk/livechat), search (имя/handle контакта или текст), period (today/week/month/all — по последней активности), unansweredOnly (только где клиент ждёт ответа), quietHours (без активности дольше N часов). Отвечает на «покажи диалоги менеджера X», «кто писал сегодня», «диалоги без ответа старше суток».',
      inputSchema: z.object({
        managerId: z.string().optional(),
        channelType: z
          .enum(['telegram', 'whatsapp', 'livechat', 'max', 'vk'])
          .optional(),
        search: z.string().max(120).optional(),
        period: z.enum(PERIODS).default('all'),
        unansweredOnly: z
          .boolean()
          .optional()
          .describe('Только диалоги с непрочитанными входящими (клиент ждёт)'),
        quietHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 90)
          .optional()
          .describe('Только диалоги БЕЗ активности дольше N часов'),
        limit: z.number().int().min(1).max(200).default(30),
      }),
      execute: async ({
        managerId,
        channelType,
        search,
        period,
        unansweredOnly,
        quietHours,
        limit,
      }) => {
        const rows = await listConversationsAdmin({
          search,
          channelType: channelType as ChannelType | undefined,
          managerId,
          activeSince: periodStart(period),
          unansweredOnly,
          quietSince: quietHours
            ? new Date(Date.now() - quietHours * 3600 * 1000).toISOString()
            : undefined,
          limit,
        })
        const payload = rows.map((c) => ({
          id: c.id,
          contactName: c.contactName || c.contactHandle,
          channelType: c.channelType,
          channelName: c.channelName ?? null,
          managerName: c.managerName,
          status: c.status ?? null,
          lastMessage: truncate(c.lastMessage ?? '', 80),
          lastMessageAt: c.lastMessageAt,
          unread: c.unread,
        }))
        state.views.push({
          kind: 'dialogs',
          title: 'Диалоги',
          payload,
        })
        return {
          count: payload.length,
          dialogs: payload.map((p) => ({
            id: p.id,
            contactName: p.contactName,
            managerName: p.managerName,
            channelType: p.channelType,
            lastMessageAt: p.lastMessageAt,
          })),
        }
      },
    }),

    show_dialog: tool({
      description:
        'Открыть переписку: последние сообщения конкретного диалога по его id (id бери из list_dialogs). Показывает кто что писал, включая ответы ИИ.',
      inputSchema: z.object({
        conversationId: z.string().min(1),
        limit: z.number().int().min(5).max(100).default(30),
      }),
      execute: async ({ conversationId, limit }) => {
        const convo = await getConversationAdmin(conversationId)
        if (!convo) return { ok: false, message: 'Диалог не найден' }
        const messages = await listMessagesAdmin(conversationId, { limit })
        const payload = {
          contactName: convo.contactName || convo.contactHandle,
          managerName: convo.managerName,
          channelType: convo.channelType,
          messages: messages.map((m) => ({
            direction: m.direction,
            author: m.author,
            body: truncate(m.body ?? '', 500),
            createdAt: m.createdAt,
          })),
        }
        state.views.push({
          kind: 'messages',
          title: `Диалог с ${payload.contactName}`,
          payload,
        })
        return {
          ok: true,
          contact: payload.contactName,
          manager: convo.managerName,
          messageCount: messages.length,
          lastMessages: payload.messages.slice(-10),
        }
      },
    }),

    manager_activity: tool({
      description:
        'Активность по менеджерам за период: сколько людей НАПИСАЛО каждому менеджеру, входящие сообщения, новые диалоги, без ответа. Отвечает на «сколько людей написало сегодня менеджеру X», «у кого больше всего диалогов».',
      inputSchema: z.object({
        period: z.enum(['today', 'week', 'month']).default('today'),
      }),
      execute: async ({ period }) => {
        const since = periodStart(period)!
        const rows = await listManagerActivity(since)
        const title =
          period === 'today'
            ? 'Активность менеджеров сегодня'
            : period === 'week'
              ? 'Активность менеджеров за неделю'
              : 'Активность менеджеров за месяц'
        state.views.push({ kind: 'manager_activity', title, payload: rows })
        return rows
      },
    }),

    send_message: tool({
      description:
        'Отправить сообщение клиенту в диалог от имени менеджера-владельца. Текст пиши сам по просьбе админа (или бери его формулировку). ОПАСНО: не отправляется сразу — вернёт needsConfirmation, попроси админа подтвердить. conversationId бери из list_dialogs / show_dialog.',
      inputSchema: z.object({
        conversationId: z.string().min(1),
        body: z.string().min(1).max(2000).describe('Текст сообщения клиенту'),
      }),
      execute: async ({ conversationId, body }) => {
        const convo = await getConversationAdmin(conversationId)
        if (!convo) return { ok: false, message: 'Диалог не найден' }
        if (!convo.managerId)
          return {
            ok: false,
            message:
              'У диалога нет менеджера-владельца — сначала передай его менеджеру (reassign_dialogs)',
          }
        const contact = convo.contactName || convo.contactHandle
        state.pending = {
          kind: 'send_message',
          label: `Отправить сообщение → ${contact}`,
          detail: `От имени ${convo.managerName ?? 'менеджера'} в ${convo.channelType}: «${truncate(body, 200)}». Клиент получит его как обычный ответ менеджера.`,
          payload: { conversationId, body },
        }
        return { ok: true, needsConfirmation: true, contact }
      },
    }),

    reassign_dialogs: tool({
      description:
        'Передать диалоги другому менеджеру. Либо ВСЕ диалоги менеджера (fromManagerId), либо конкретные (conversationIds). ОПАСНО: не применяется сразу — вернёт needsConfirmation, попроси админа подтвердить. Ids менеджеров бери из list_managers.',
      inputSchema: z.object({
        toManagerId: z.string().min(1),
        fromManagerId: z
          .string()
          .optional()
          .describe('Передать ВСЕ диалоги этого менеджера'),
        conversationIds: z
          .array(z.string())
          .max(200)
          .optional()
          .describe('Или конкретные диалоги (ids из list_dialogs)'),
      }),
      execute: async ({ toManagerId, fromManagerId, conversationIds }) => {
        if (!fromManagerId && (!conversationIds || conversationIds.length === 0))
          return {
            ok: false,
            message: 'Укажи fromManagerId или conversationIds',
          }
        const to = await getManagerById(toManagerId)
        if (!to) return { ok: false, message: 'Целевой менеджер не найден' }
        if (to.status !== 'active')
          return { ok: false, message: `Менеджер ${to.name} заблокирован` }

        let detail: string
        let label: string
        if (fromManagerId) {
          const from = await getManagerById(fromManagerId)
          if (!from)
            return { ok: false, message: 'Исходный менеджер не найден' }
          label = `Передать диалоги: ${from.name} → ${to.name}`
          detail = `ВСЕ диалоги менеджера ${from.name} перейдут к ${to.name}. История сообщений сохранится, новый владелец увидит их в своём инбоксе.`
        } else {
          label = `Передать ${conversationIds!.length} диалог(ов) → ${to.name}`
          detail = `${conversationIds!.length} диалог(ов) перейдут к ${to.name}. История сообщений сохранится.`
        }
        state.pending = {
          kind: 'reassign_dialogs',
          label,
          detail,
          payload: {
            toManagerId,
            fromManagerId: fromManagerId ?? null,
            conversationIds: conversationIds ?? null,
          },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),
  }
}
