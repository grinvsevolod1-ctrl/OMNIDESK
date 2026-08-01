import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  listKnowledge,
  upsertKnowledge,
  deleteKnowledge,
  addLesson,
  deleteLesson,
  listLessons,
  retrieveKnowledge,
} from '@/lib/data/ai-assist'
import { truncate, type RunState } from './run-state'

/**
 * Knowledge-base and training-lesson tools: facts CRUD, lessons CRUD and the
 * semantic-first search across both.
 */
export function knowledgeTools(state: RunState) {
  return {
    addKnowledge: tool({
      description:
        'Добавить точный факт в базу знаний ИИ-менеджера (цена, условие, ответ на частый вопрос). title — короткий заголовок, content — сам факт.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(4000),
      }),
      execute: async ({ title, content }) => {
        await upsertKnowledge({ title: title.trim(), content: content.trim() })
        state.actions.push({ kind: 'knowledge', label: `Факт: «${title.trim()}»` })
        return { ok: true }
      },
    }),

    listKnowledge: tool({
      description:
        'Показать всё, что сейчас лежит в базе знаний ИИ-менеджера (факты, цены, ответы на частые вопросы). Вызывай, когда админ просит «что ты знаешь», «покажи базу знаний», «какие факты сохранены», или перед тем как что-то изменить/удалить — чтобы взять id нужной записи.',
      inputSchema: z.object({}),
      execute: async () => {
        const items = await listKnowledge()
        return {
          ok: true,
          count: items.length,
          items: items.map((k) => ({
            id: k.id,
            title: k.title,
            content: truncate(k.content, 200),
            enabled: k.enabled,
          })),
        }
      },
    }),

    updateKnowledge: tool({
      description:
        'Изменить существующий факт в базе знаний: поправить текст, заголовок или временно выключить/включить его. Сначала возьми id через listKnowledge. Передай id и то, что меняешь (title / content / enabled).',
      inputSchema: z.object({
        id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        content: z.string().min(1).max(4000).optional(),
        enabled: z.boolean().optional(),
      }),
      execute: async ({ id, title, content, enabled }) => {
        const current = await listKnowledge()
        const entry = current.find((k) => k.id === id)
        if (!entry) return { ok: false, reason: 'not_found' }
        await upsertKnowledge({
          id,
          title: (title ?? entry.title).trim(),
          content: (content ?? entry.content).trim(),
          enabled: enabled ?? entry.enabled,
        })
        state.actions.push({
          kind: 'knowledge',
          label:
            enabled === false
              ? `Выключил факт: «${truncate(title ?? entry.title, 50)}»`
              : `Обновил факт: «${truncate(title ?? entry.title, 50)}»`,
        })
        return { ok: true }
      },
    }),

    deleteKnowledge: tool({
      description:
        'Удалить факт из базы знаний навсегда. Сначала возьми id через listKnowledge и убедись, что админ действительно хочет удалить именно эту запись. Передай id.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const current = await listKnowledge()
        const entry = current.find((k) => k.id === id)
        if (!entry) return { ok: false, reason: 'not_found' }
        await deleteKnowledge(id)
        state.actions.push({
          kind: 'knowledge',
          label: `Удалил факт: «${truncate(entry.title, 50)}»`,
        })
        return { ok: true }
      },
    }),

    addLesson: tool({
      description:
        'Добавить обучающий урок — как ИИ должен отвечать в определённой ситуации. situation — ситуация/запрос клиента, corrected — правильный ответ, note — короткое пояснение почему.',
      inputSchema: z.object({
        situation: z.string().min(1).max(1000),
        corrected: z.string().min(1).max(2000),
        note: z.string().max(500).optional(),
      }),
      execute: async ({ situation, corrected, note }) => {
        await addLesson({
          situation: situation.trim(),
          draft: '',
          corrected: corrected.trim(),
          note: (note ?? '').trim(),
        })
        state.actions.push({ kind: 'lesson', label: 'Добавил урок в обучение' })
        return { ok: true }
      },
    }),

    listLessons: tool({
      description:
        'Показать сохранённые обучающие уроки ИИ-менеджера (ситуация клиента → правильный ответ). Вызывай, когда админ просит «покажи уроки», «чему ты научен», или перед удалением урока — чтобы взять его id.',
      inputSchema: z.object({}),
      execute: async () => {
        const items = await listLessons(50)
        return {
          ok: true,
          count: items.length,
          items: items.map((l) => ({
            id: l.id,
            situation: truncate(l.situation, 140),
            corrected: truncate(l.corrected, 200),
            note: l.note,
          })),
        }
      },
    }),

    deleteLesson: tool({
      description:
        'Удалить обучающий урок навсегда. Сначала возьми id через listLessons и убедись, что админ хочет убрать именно его. Передай id.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const items = await listLessons(200)
        const lesson = items.find((l) => l.id === id)
        if (!lesson) return { ok: false, reason: 'not_found' }
        await deleteLesson(id)
        state.actions.push({
          kind: 'lesson',
          label: `Удалил урок: «${truncate(lesson.situation, 50)}»`,
        })
        return { ok: true }
      },
    }),

    searchKnowledge: tool({
      description:
        'Найти, что ИИ-менеджер уже знает: ищет по базе знаний (факты) и обучающим урокам. Используй, когда админ спрашивает «что ты знаешь про…», «есть ли факт о…», «как ты отвечаешь на…», «чему тебя учили». Без query возвращает свежие записи.',
      inputSchema: z.object({
        query: z.string().max(200).optional(),
      }),
      execute: async ({ query }) => {
        const [knowledge, lessons] = await Promise.all([
          listKnowledge(),
          listLessons(50),
        ])
        const q = (query ?? '').trim().toLowerCase()
        const match = (s: string) => !q || s.toLowerCase().includes(q)
        // Semantic-first: the same embedding retrieval the seller brain uses,
        // so «что ты знаешь про доставку?» finds the fact even when worded
        // differently. retrieveKnowledge returns a pre-formatted bullet list
        // ('' when RAG is unavailable); substring stays as the fallback.
        let semanticHits = ''
        if (q) {
          semanticHits = await retrieveKnowledge(q, 8).catch(() => '')
        }
        const facts = semanticHits
          ? semanticHits
              .split('\n')
              .filter((line) => line.trim())
              .map((line) => ({ title: '', content: line.replace(/^•\s*/, '') }))
          : knowledge
              .filter((k) => match(k.title) || match(k.content))
              .slice(0, 8)
              .map((k) => ({ title: k.title, content: k.content }))
        const trainedOn = lessons
          .filter(
            (l) => match(l.situation) || match(l.corrected) || match(l.note),
          )
          .slice(0, 8)
          .map((l) => ({
            situation: l.situation,
            answer: l.corrected,
            note: l.note,
          }))
        return {
          query: q || null,
          factCount: facts.length,
          lessonCount: trainedOn.length,
          facts,
          lessons: trainedOn,
        }
      },
    }),
  }
}
