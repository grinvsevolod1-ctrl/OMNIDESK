import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import { getAiAssistSettings, listKnowledge } from '@/lib/data/ai-assist'
import {
  addDirective,
  listDirectives,
  removeDirective,
  reorderDirectives,
  setDirectiveEnabled,
  updateDirective,
} from '@/lib/data/ai-directives'
import { truncate, type RunState } from './run-state'

/**
 * Direct-instruction (directive) tools: the durable rules the admin dictates
 * in his own words, plus the full-audit bundle for contradiction review.
 */
export function directiveTools(state: RunState) {
  return {
    rememberDirective: tool({
      description:
        'ЗАПОМНИТЬ ПРЯМОЕ УКАЗАНИЕ (правило/сценарий) для ИИ-менеджера — то, что админ диктует своими словами: «всегда сначала спрашивай бюджет», «никогда не обещай скидку больше 10%», «если упомянут конкурент — делай так». Правило durable (не стирается обучением) и попадает в КАЖДЫЙ ответ клиенту во всех каналах, включая Telegram, с высшим приоритетом. Вызывай, когда админ говорит «запомни», «правило», «всегда/никогда», «делай так», «вот сценарий». Можешь слегка причесать формулировку, не меняя смысла.',
      inputSchema: z.object({
        body: z.string().min(1).max(2000),
      }),
      execute: async ({ body }) => {
        const created = await addDirective(body.trim())
        state.actions.push({
          kind: 'directive',
          label: `Запомнил правило: «${truncate(created.body, 60)}»`,
        })
        return { ok: true, id: created.id, position: created.sortOrder + 1 }
      },
    }),

    listDirectives: tool({
      description:
        'Показать все прямые указания (правила/сценарии), которые сейчас помнит ИИ-менеджер, в порядке применения. Вызывай, когда админ спрашивает «какие у тебя правила», «что ты помнишь», «покажи сценарии», а ТАКЖЕ обязательно перед тем, как изменить/удалить/переставить/включить-выключить конкретное правило — чтобы взять его id.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listDirectives()
        return {
          count: rows.length,
          directives: rows.map((d, i) => ({
            position: i + 1,
            id: d.id,
            body: d.body,
            enabled: d.enabled,
          })),
        }
      },
    }),

    updateDirective: tool({
      description:
        'Изменить формулировку существующего правила. Сначала вызови listDirectives, чтобы взять id нужного правила. Полностью перезаписывает текст правила.',
      inputSchema: z.object({
        id: z.string().min(1),
        body: z.string().min(1).max(2000),
      }),
      execute: async ({ id, body }) => {
        const updated = await updateDirective(id, body.trim())
        if (!updated) return { ok: false, reason: 'not_found' }
        state.actions.push({
          kind: 'directive',
          label: `Изменил правило: «${truncate(updated.body, 60)}»`,
        })
        return { ok: true }
      },
    }),

    toggleDirective: tool({
      description:
        'Временно приостановить (enabled=false) или снова включить (enabled=true) правило, не удаляя его. Сначала вызови listDirectives, чтобы взять id.',
      inputSchema: z.object({
        id: z.string().min(1),
        enabled: z.boolean(),
      }),
      execute: async ({ id, enabled }) => {
        const updated = await setDirectiveEnabled(id, enabled)
        if (!updated) return { ok: false, reason: 'not_found' }
        state.actions.push({
          kind: 'directive',
          label: `${enabled ? 'Включил' : 'Приостановил'} правило: «${truncate(updated.body, 50)}»`,
        })
        return { ok: true }
      },
    }),

    forgetDirective: tool({
      description:
        'Насовсем удалить правило. Сначала вызови listDirectives, чтобы взять id. Удаление необратимо — если админ, возможно, захочет вернуть правило, лучше toggleDirective (приостановить).',
      inputSchema: z.object({
        id: z.string().min(1),
      }),
      execute: async ({ id }) => {
        const ok = await removeDirective(id)
        if (!ok) return { ok: false, reason: 'not_found' }
        state.actions.push({ kind: 'directive', label: 'Удалил правило' })
        return { ok: true }
      },
    }),

    reorderDirectives: tool({
      description:
        'Переставить правила в новом порядке приоритета (первое = самое важное). Передай orderedIds — массив id в желаемом порядке. Сначала вызови listDirectives, чтобы взять актуальные id.',
      inputSchema: z.object({
        orderedIds: z.array(z.string().min(1)).min(1),
      }),
      execute: async ({ orderedIds }) => {
        await reorderDirectives(orderedIds)
        state.actions.push({ kind: 'directive', label: 'Переставил порядок правил' })
        return { ok: true }
      },
    }),

    auditDirectives: tool({
      description:
        'Собрать ПОЛНЫЙ набор того, чем живёт продавец — все правила (включая выключенные), персону, тон, агрессивность и заголовки базы знаний — одним пакетом для ревизии. Вызывай, когда админ просит «проверь мои правила», «нет ли противоречий», «наведи порядок в правилах», а также ПОСЛЕ generateScenario. Получив пакет, САМ внимательно сверь правила между собой и с персоной: найди противоречия (одно правило запрещает то, что требует другое), дубли, устаревшее и рискованное для продаж. Доложи коротким списком «правило N ↔ правило M: в чём конфликт» и предложи, что поправить — но ничего не меняй без согласия админа.',
      inputSchema: z.object({}),
      execute: async () => {
        const [directives, settings, knowledge] = await Promise.all([
          listDirectives(),
          getAiAssistSettings(),
          listKnowledge(),
        ])
        return {
          ok: true,
          persona: settings.persona,
          tone: settings.tone,
          aggressiveness: settings.aggressiveness,
          directives: directives.map((d, i) => ({
            position: i + 1,
            id: d.id,
            body: d.body,
            enabled: d.enabled,
          })),
          knowledgeTitles: knowledge.map((k) => k.title).slice(0, 40),
        }
      },
    }),
  }
}
