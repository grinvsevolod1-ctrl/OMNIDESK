import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import { getFinanceData } from '@/lib/finance'
import { truncate, type RunState } from './run-state'

/**
 * Finance / accounting ("Учёт"). READ-focused: the vault (passwords/keys) is
 * intentionally NOT exposed here — secrets never flow through the model.
 * Entry deletion is guarded; entry creation goes through the classic UI.
 */
export function financeTools(state: RunState) {
  return {
    show_finance: tool({
      description:
        'Финансовый срез: ресурсы (проекты), разделы, записи расходов с суммами в USD, рекламные кабинеты. Хранилище секретов НЕ включено.',
      inputSchema: z.object({
        resourceName: z
          .string()
          .optional()
          .describe('Фильтр по названию ресурса (подстрока)'),
      }),
      execute: async ({ resourceName }) => {
        const data = await getFinanceData()
        const resources = resourceName
          ? data.resources.filter((r) =>
              r.name.toLowerCase().includes(resourceName.toLowerCase()),
            )
          : data.resources
        const resourceIds = new Set(resources.map((r) => r.id))
        const entries = data.entries.filter((e) => resourceIds.has(e.resourceId))
        const totalUsd = entries.reduce((s, e) => s + e.amount, 0)
        const payload = {
          resources: resources.map((r) => ({
            id: r.id,
            name: r.name,
            currency: r.currency,
            archived: r.archived,
          })),
          sections: data.sections.filter((s) => resourceIds.has(s.resourceId)),
          entries: entries.map((e) => ({
            id: e.id,
            title: e.title,
            vendor: e.vendor,
            amount: e.amount,
            status: e.status,
            entryDate: e.entryDate,
            dueDate: e.dueDate,
          })),
          totalUsd,
        }
        state.views.push({ kind: 'finance', title: 'Учёт', payload })
        return payload
      },
    }),

    delete_finance_entry: tool({
      description:
        'Удалить запись расхода. ОПАСНО: вернёт needsConfirmation — попроси админа подтвердить кнопкой.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const data = await getFinanceData()
        const entry = data.entries.find((e) => e.id === id)
        if (!entry) return { ok: false, message: 'Запись не найдена' }
        state.pending = {
          kind: 'delete_finance_entry',
          label: `Удалить запись «${truncate(entry.title, 40)}»`,
          detail: `Запись на $${entry.amount.toFixed(2)} (${entry.vendor || 'без поставщика'}) будет удалена безвозвратно.`,
          payload: { id },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),
  }
}
