import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import { getDictionaries, updateDictionaryEntry } from '@/lib/data/dictionaries'
import { truncate, type RunState } from './run-state'

/**
 * Managed dictionaries: every human-readable caption in the panel (lead-status
 * names like «Ликвид», channel type labels, account/proxy/server statuses,
 * shell quick commands, greeting) is editable here. Internal enum KEYS are
 * immutable — only their presentation changes.
 */
export function dictionaryTools(state: RunState) {
  return {
    show_dictionaries: tool({
      description:
        'Показать все справочники: статусы лидов (названия/описания), причины неликвида, подписи каналов, статусы аккаунтов/прокси/серверов, быстрые команды. Вызывай перед переименованием, чтобы узнать точные ключи.',
      inputSchema: z.object({}),
      execute: async () => {
        const dict = await getDictionaries()
        state.views.push({
          kind: 'dictionaries',
          title: 'Справочники',
          payload: dict,
        })
        return dict
      },
    }),

    manage_dictionary: tool({
      description:
        'Изменить элемент справочника: переименовать статус лида («Ликвид» → «Горячий»), поменять описание, подпись канала и т.п. section: leadStatuses | notLiquidReasons | channelTypes | accountStatuses | proxyStatuses | serverStatuses | appStatuses | deploymentStatuses. key — внутренний ключ из show_dictionaries. Меняется только отображение, ключи стабильны.',
      inputSchema: z.object({
        section: z.enum([
          'leadStatuses',
          'notLiquidReasons',
          'channelTypes',
          'accountStatuses',
          'proxyStatuses',
          'serverStatuses',
          'appStatuses',
          'deploymentStatuses',
        ]),
        key: z.string().min(1),
        label: z.string().optional().describe('Новое название'),
        description: z
          .string()
          .optional()
          .describe('Новое описание (только для leadStatuses/notLiquidReasons)'),
      }),
      execute: async ({ section, key, label, description }) => {
        const res = await updateDictionaryEntry({
          section,
          key,
          label,
          description,
        })
        if (!res.ok) return res
        state.actions.push({
          kind: 'dictionary',
          label: label
            ? `Переименовал «${key}» → «${truncate(label, 30)}»`
            : `Обновил справочник ${section}`,
        })
        return { ok: true, updated: { section, key, label, description } }
      },
    }),

    set_shell_greeting: tool({
      description: 'Изменить приветственный текст командной оболочки.',
      inputSchema: z.object({ text: z.string().min(1).max(300) }),
      execute: async ({ text }) => {
        const res = await updateDictionaryEntry({ section: 'shellGreeting', text })
        if (!res.ok) return res
        state.actions.push({ kind: 'dictionary', label: 'Обновил приветствие' })
        return { ok: true }
      },
    }),

    set_quick_commands: tool({
      description:
        'Заменить список быстрых команд-чипов оболочки (полная замена списка).',
      inputSchema: z.object({
        commands: z
          .array(
            z.object({
              label: z.string().min(1).max(60),
              prompt: z.string().min(1).max(200),
            }),
          )
          .min(1)
          .max(8),
      }),
      execute: async ({ commands }) => {
        const res = await updateDictionaryEntry({
          section: 'shellQuickCommands',
          quickCommands: commands,
        })
        if (!res.ok) return res
        state.actions.push({
          kind: 'dictionary',
          label: `Обновил быстрые команды (${commands.length})`,
        })
        return { ok: true }
      },
    }),
  }
}
