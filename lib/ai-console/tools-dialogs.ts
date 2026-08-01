import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  listAiEnrolledConversations,
  listEnrollableConversations,
  enrollConversationAi,
  unenrollConversationAi,
} from '@/lib/data/ai-assist'
import { getDialogTranscript } from '@/lib/data/ai-analytics'
import {
  getFollowupSettings,
  updateFollowupSettings,
} from '@/lib/data/ai-followup'
import type { RunState } from './run-state'

/**
 * Dialog-management and follow-up tools: list/attach/detach AI on live
 * conversations, read a full transcript, and configure the auto-follow-up.
 * Enabling follow-up is guarded (needsConfirmation) — the AI starts messaging
 * clients unprompted.
 */
export function dialogTools(state: RunState) {
  return {
    listDialogs: tool({
      description:
        'Показать диалоги: какие сейчас ведёт ИИ и какие можно ему поручить. Вызывай, когда админ спрашивает «какие диалоги на ИИ», «кого ведёт бот», «подключи ИИ к диалогу с …» (сначала найди нужный), «покажи переписки». Без search и с scope=enrolled — вернёт диалоги под управлением ИИ; со scope=all или строкой поиска — доступные для подключения (можно искать по имени контакта). Бери conversationId отсюда для attachAi/detachAi.',
      inputSchema: z.object({
        scope: z.enum(['enrolled', 'all']).optional(),
        search: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ scope, search, limit }) => {
        const cap = limit ?? 30
        const items =
          scope === 'all' || (search && search.trim())
            ? await listEnrollableConversations(search ?? '', cap)
            : await listAiEnrolledConversations(cap)
        return {
          ok: true,
          count: items.length,
          dialogs: items.map((d) => ({
            conversationId: d.conversationId,
            contact: d.contactName,
            channel: d.channelType,
            lastMessage: d.lastMessage,
            aiLed: d.enrolled,
          })),
        }
      },
    }),

    attachAi: tool({
      description:
        'Подключить ИИ-менеджера к конкретному диалогу — дальше бот сам ведёт клиента (с текущего момента, старую переписку не переигрывает). Сначала найди нужный диалог через listDialogs и возьми conversationId. Вызывай, когда админ говорит «подключи ИИ к диалогу с …», «пусть бот ведёт этого клиента».',
      inputSchema: z.object({ conversationId: z.string().min(1) }),
      execute: async ({ conversationId }) => {
        const ok = await enrollConversationAi(conversationId)
        if (!ok) return { ok: false, reason: 'not_found' }
        state.settingsChanged = true
        state.actions.push({ kind: 'dialog', label: 'Подключил ИИ к диалогу' })
        return { ok: true }
      },
    }),

    detachAi: tool({
      description:
        'Отключить ИИ от диалога — человек полностью забирает переписку себе. Сначала возьми conversationId через listDialogs (scope=enrolled). Вызывай, когда админ говорит «убери бота из диалога», «дальше веду сам», «отключи ИИ от этого клиента».',
      inputSchema: z.object({ conversationId: z.string().min(1) }),
      execute: async ({ conversationId }) => {
        const ok = await unenrollConversationAi(conversationId)
        if (!ok) return { ok: false, reason: 'not_found' }
        state.settingsChanged = true
        state.actions.push({ kind: 'dialog', label: 'Отключил ИИ от диалога' })
        return { ok: true }
      },
    }),

    readDialog: tool({
      description:
        'Прочитать ПОЛНУЮ переписку конкретного диалога (кто что писал, по репликам, с датами) плюс статус, канал и температуру подключения ИИ. Вызывай, когда админ просит «покажи переписку с …», «что бот ответил этому клиенту», «почему этот клиент слился», «разбери диалог с …». Сначала найди диалог через listDialogs (поиск по имени) и возьми conversationId. Разбирая диалог, цитируй ключевые реплики и говори конкретно: где ответ был хорош, где потеряли клиента и каким правилом/уроком это чинится.',
      inputSchema: z.object({ conversationId: z.string().min(1) }),
      execute: async ({ conversationId }) => {
        const t = await getDialogTranscript(conversationId)
        if (!t) return { ok: false, reason: 'not_found' }
        return { ok: true, ...t }
      },
    }),

    getFollowupStatus: tool({
      description:
        'Показать текущие настройки авто-дожима (follow-up): включён ли, через сколько часов молчания напоминать, сколько напоминаний максимум, тихие часы, каналы. Вызывай, когда админ спрашивает «дожимаешь ли ты молчунов», «как настроен авто-дожим», «напоминаешь ли клиентам».',
      inputSchema: z.object({}),
      execute: async () => {
        const s = await getFollowupSettings()
        return { ok: true, ...s }
      },
    }),

    configureFollowup: tool({
      description:
        'Настроить авто-дожим (follow-up) молчащих клиентов: ИИ сам напоминает о себе, если клиент перестал отвечать. Вызывай, когда админ просит «дожимай молчунов», «напоминай, если не отвечают», «пиши сам через N часов», «хватит по два напоминания», «не беспокой ночью», «мой часовой пояс — …». Можно менять задержку, число касаний, тихие часы (когда не писать), часовой пояс тихих часов и каналы. quietTz — строка вида «Europe/Moscow», «Asia/Yekaterinburg»: по ней вычисляются тихие часы. ВКЛЮЧЕНИЕ (enabled=true) высокоэффективно — оно требует подтверждения администратора и вернёт needsConfirmation, не применяясь сразу. Все прочие изменения и выключение применяются сразу.',
      inputSchema: z.object({
        enabled: z.boolean().optional(),
        delayHours: z.number().int().min(1).max(720).optional(),
        maxTouches: z.number().int().min(1).max(5).optional(),
        quietStart: z.number().int().min(0).max(23).optional(),
        quietEnd: z.number().int().min(0).max(23).optional(),
        quietTz: z.string().min(1).max(64).optional(),
        channels: z
          .array(z.enum(['livechat', 'whatsapp', 'vk', 'max', 'telegram']))
          .optional(),
      }),
      execute: async ({
        enabled,
        delayHours,
        maxTouches,
        quietStart,
        quietEnd,
        quietTz,
        channels,
      }) => {
        // Guard: turning follow-up ON makes the AI message clients unprompted →
        // require explicit admin confirmation, exactly like enabling max pressure.
        if (enabled === true) {
          state.pending = {
            kind: 'enable_followup',
            label: 'Включить авто-дожим (follow-up)',
            detail:
              'После включения ИИ будет сам писать напоминания клиентам, которые перестали отвечать (с учётом тихих часов).',
          }
          return { ok: true, needsConfirmation: true }
        }
        // Validate the timezone against the runtime's IANA database so we never
        // persist a bogus zone that would silently break quiet-hour math.
        if (quietTz != null) {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: quietTz })
          } catch {
            return { ok: false, reason: 'invalid_timezone', quietTz }
          }
        }
        const patch: Parameters<typeof updateFollowupSettings>[0] = {}
        if (enabled === false) patch.enabled = false
        if (delayHours != null) patch.delayHours = delayHours
        if (maxTouches != null) patch.maxTouches = maxTouches
        if (quietStart != null) patch.quietStart = quietStart
        if (quietEnd != null) patch.quietEnd = quietEnd
        if (quietTz != null) patch.quietTz = quietTz
        if (channels != null) patch.channels = channels
        if (Object.keys(patch).length === 0) {
          return { ok: true, unchanged: true }
        }
        const next = await updateFollowupSettings(patch)
        state.settingsChanged = true
        state.actions.push({
          kind: 'followup',
          label:
            enabled === false
              ? 'Выключил авто-дожим'
              : 'Обновил настройки авто-дожима',
        })
        return { ok: true, ...next }
      },
    }),
  }
}
