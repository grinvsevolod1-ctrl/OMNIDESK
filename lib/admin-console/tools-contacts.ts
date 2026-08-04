import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import { listContactsByChannel } from '@/lib/data'
import { getDictionaries } from '@/lib/data/dictionaries'
import type { RunState } from './run-state'

/** Contacts / leads database: browse by channel + CSV export. */
export function contactTools(state: RunState) {
  return {
    show_contacts: tool({
      description:
        'База контактов, сгруппированная по типу канала: сколько лидов в каждом, статусы. Названия статусов — из справочника.',
      inputSchema: z.object({}),
      execute: async () => {
        const [groups, dict] = await Promise.all([
          listContactsByChannel(),
          getDictionaries(),
        ])
        const summary = groups.map((g) => ({
          channelType: g.channelType,
          channelLabel: dict.channelTypes[g.channelType] ?? g.channelType,
          count: g.count,
        }))
        state.views.push({
          kind: 'contacts',
          title: 'Контакты по каналам',
          payload: { groups, leadStatuses: dict.leadStatuses },
        })
        return { summary }
      },
    }),

    export_contacts: tool({
      description:
        'Выгрузить контакты одного типа канала в CSV — админ получит кнопку «Скачать». channelType бери из show_contacts.',
      inputSchema: z.object({ channelType: z.string().min(1) }),
      execute: async ({ channelType }) => {
        const [groups, dict] = await Promise.all([
          listContactsByChannel(),
          getDictionaries(),
        ])
        const group = groups.find((g) => g.channelType === channelType)
        if (!group) return { ok: false, message: 'Нет контактов такого типа' }
        const header = ['Имя', 'Идентификатор', 'Username', 'Статус', 'Создан']
        const lines = group.contacts.map((c) =>
          [
            c.contactName,
            c.contactHandle,
            c.contactUsername ?? '',
            dict.leadStatuses[c.status]?.label ?? c.status,
            c.createdAt,
          ]
            .map((v) => `"${String(v).replaceAll('"', '""')}"`)
            .join(','),
        )
        state.report = {
          filename: `contacts-${channelType}.csv`,
          mimeType: 'text/csv',
          content: [header.join(','), ...lines].join('\n'),
          label: `Контакты ${dict.channelTypes[channelType] ?? channelType} (${group.count})`,
        }
        state.actions.push({
          kind: 'report',
          label: `Выгрузка контактов: ${group.count} строк`,
        })
        return { ok: true, rows: group.count }
      },
    }),
  }
}
