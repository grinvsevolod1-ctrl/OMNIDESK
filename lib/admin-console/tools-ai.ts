import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  addDirective,
  listDirectives,
  setDirectiveEnabled,
  updateDirective,
} from '@/lib/data/ai-directives'
import { listKnowledge, upsertKnowledge } from '@/lib/data/ai-assist'
import { truncate, type RunState } from './run-state'

/**
 * AI-manager configuration tools: the copilot edits the autopilot's mandate
 * (directives) and its RAG knowledge base in natural language — «добавь
 * правило: на вопрос о цене отвечай …», «добавь в знания статью про тарифы».
 *
 * Additive edits apply immediately (reversible: disable/re-edit). DELETIONS
 * are guarded behind pending confirmations — losing a directive or a
 * knowledge article silently would change the AI's behavior invisibly.
 */
export function aiTools(state: RunState) {
  return {
    list_directives: tool({
      description:
        'Директивы ИИ-менеджера (правила поведения автопилота): текст, включена/выключена, порядок. Вызывай перед изменением/удалением, чтобы получить точный id.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listDirectives()
        const payload = rows.map((d) => ({
          id: d.id,
          body: d.body,
          enabled: d.enabled,
          sortOrder: d.sortOrder,
        }))
        state.views.push({
          kind: 'directives',
          title: 'Директивы ИИ-менеджера',
          payload,
        })
        return payload.map((d) => ({
          id: d.id,
          body: truncate(d.body, 160),
          enabled: d.enabled,
        }))
      },
    }),

    add_directive: tool({
      description:
        'Добавить директиву (правило) ИИ-менеджеру, например «на вопрос о цене называй тариф и предлагай созвон». Применяется сразу — правило обратимо (можно выключить или изменить).',
      inputSchema: z.object({
        body: z.string().min(3).max(2000).describe('Текст правила'),
      }),
      execute: async ({ body }) => {
        const d = await addDirective(body)
        state.actions.push({
          kind: 'ai',
          label: `Добавил директиву: ${truncate(body, 60)}`,
        })
        return { ok: true, id: d.id }
      },
    }),

    update_directive: tool({
      description:
        'Изменить текст директивы ИИ-менеджера или включить/выключить её. Id бери из list_directives.',
      inputSchema: z.object({
        id: z.string().min(1),
        body: z.string().min(3).max(2000).optional().describe('Новый текст'),
        enabled: z.boolean().optional().describe('Включить/выключить'),
      }),
      execute: async ({ id, body, enabled }) => {
        if (body === undefined && enabled === undefined)
          return { ok: false, message: 'Укажи body и/или enabled' }
        if (body !== undefined) {
          const updated = await updateDirective(id, body)
          if (!updated) return { ok: false, message: 'Директива не найдена' }
        }
        if (enabled !== undefined) {
          const toggled = await setDirectiveEnabled(id, enabled)
          if (!toggled) return { ok: false, message: 'Директива не найдена' }
        }
        state.actions.push({
          kind: 'ai',
          label:
            body !== undefined
              ? `Изменил директиву: ${truncate(body, 60)}`
              : enabled
                ? 'Включил директиву'
                : 'Выключил директиву',
        })
        return { ok: true }
      },
    }),

    remove_directive: tool({
      description:
        'Удалить директиву ИИ-менеджера НАВСЕГДА. ОПАСНО: не применяется сразу — вернёт needsConfirmation. Если правило нужно лишь приостановить — используй update_directive с enabled=false.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const rows = await listDirectives()
        const d = rows.find((r) => r.id === id)
        if (!d) return { ok: false, message: 'Директива не найдена' }
        state.pending = {
          kind: 'delete_directive',
          label: 'Удалить директиву',
          detail: `Безвозвратно: «${truncate(d.body, 200)}». Автопилот перестанет следовать этому правилу.`,
          payload: { id },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),

    list_knowledge: tool({
      description:
        'База знаний ИИ-менеджера (статьи, из которых автопилот берёт факты): заголовок, включена/выключена. Вызывай перед изменением/удалением, чтобы получить точный id.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listKnowledge()
        const payload = rows.map((k) => ({
          id: k.id,
          title: k.title,
          enabled: k.enabled,
          updatedAt: k.updatedAt,
          preview: truncate(k.content, 120),
        }))
        state.views.push({
          kind: 'knowledge',
          title: 'База знаний ИИ',
          payload,
        })
        return payload.map((k) => ({
          id: k.id,
          title: k.title,
          enabled: k.enabled,
        }))
      },
    }),

    upsert_knowledge: tool({
      description:
        'Добавить статью в базу знаний ИИ-менеджера или обновить существующую (передай её id из list_knowledge). Применяется сразу.',
      inputSchema: z.object({
        id: z.string().optional().describe('Id существующей статьи (обновление)'),
        title: z.string().min(2).max(200),
        content: z.string().min(3).max(8000),
      }),
      execute: async ({ id, title, content }) => {
        const entry = await upsertKnowledge({ id, title, content })
        state.actions.push({
          kind: 'ai',
          label: `${id ? 'Обновил' : 'Добавил'} знание: ${truncate(title, 60)}`,
        })
        return { ok: true, id: entry.id }
      },
    }),

    remove_knowledge: tool({
      description:
        'Удалить статью из базы знаний ИИ НАВСЕГДА. ОПАСНО: не применяется сразу — вернёт needsConfirmation. Id бери из list_knowledge.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const rows = await listKnowledge()
        const k = rows.find((r) => r.id === id)
        if (!k) return { ok: false, message: 'Статья не найдена' }
        state.pending = {
          kind: 'delete_knowledge',
          label: `Удалить знание «${truncate(k.title, 60)}»`,
          detail: 'Безвозвратно: автопилот перестанет использовать эту статью в ответах.',
          payload: { id },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),
  }
}
