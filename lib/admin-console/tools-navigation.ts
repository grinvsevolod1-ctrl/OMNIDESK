import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import { SHELL_SECTIONS } from './intents'
import type { RunState } from './run-state'

/** Navigation + generic report export. */
export function navigationTools(state: RunState) {
  return {
    open_section: tool({
      description: `Отправить админа в классический раздел панели. Доступно: ${SHELL_SECTIONS.map((s) => `${s.id} («${s.title}»)`).join(', ')}. Используй, когда задача удобнее руками (глубокие настройки, хостинг, ИИ-менеджер).`,
      inputSchema: z.object({
        section: z.enum(
          SHELL_SECTIONS.map((s) => s.id) as [string, ...string[]],
        ),
      }),
      execute: async ({ section }) => {
        const info = SHELL_SECTIONS.find((s) => s.id === section)
        state.openSection = (info?.id ?? 'overview') as typeof state.openSection
        state.actions.push({
          kind: 'navigation',
          label: `Открыл раздел «${info?.title ?? section}»`,
        })
        return { ok: true, href: info?.href ?? '/admin' }
      },
    }),

    export_report: tool({
      description:
        'Сформировать скачиваемый отчёт из произвольного текста/markdown (например сводка, которую ты сам составил из данных других инструментов).',
      inputSchema: z.object({
        filename: z.string().min(1).max(80),
        label: z.string().min(1).max(80),
        content: z.string().min(1).max(40000),
        format: z.enum(['md', 'csv', 'txt']).default('md'),
      }),
      execute: async ({ filename, label, content, format }) => {
        const mime =
          format === 'csv'
            ? 'text/csv'
            : format === 'md'
              ? 'text/markdown'
              : 'text/plain'
        const safeName = filename.endsWith(`.${format}`)
          ? filename
          : `${filename}.${format}`
        state.report = { filename: safeName, mimeType: mime, content, label }
        state.actions.push({ kind: 'report', label: `Отчёт: ${label}` })
        return { ok: true }
      },
    }),
  }
}
