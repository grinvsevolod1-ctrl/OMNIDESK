import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  getAdminStats,
  getLeadAnalytics,
  getManagerPerformance,
} from '@/lib/data'
import { getDictionaries } from '@/lib/data/dictionaries'
import { cached } from './tool-cache'
import type { RunState } from './run-state'

/** Overview/analytics tools: dashboard stats, lead funnel, manager performance. */
export function overviewTools(state: RunState) {
  return {
    show_stats: tool({
      description:
        'Показать сводные метрики системы: менеджеры (всего/активные/заблокированные), каналы по типам и подключённость.',
      inputSchema: z.object({}),
      execute: async () => {
        const stats = await cached('admin-stats', getAdminStats)
        state.views.push({ kind: 'stats', title: 'Сводка системы', payload: stats })
        return stats
      },
    }),

    show_lead_analytics: tool({
      description:
        'Воронка лидов: сколько написало, разбивка по статусам (названия статусов бери из ответа — они редактируемые), причины неликвида. Опционально по одному менеджеру.',
      inputSchema: z.object({
        managerId: z
          .string()
          .optional()
          .describe('ID менеджера, если нужен срез по одному менеджеру'),
      }),
      execute: async ({ managerId }) => {
        const [analytics, dict] = await Promise.all([
          getLeadAnalytics(managerId),
          getDictionaries(),
        ])
        state.views.push({
          kind: 'stats',
          title: 'Аналитика лидов',
          payload: { analytics, leadStatuses: dict.leadStatuses },
        })
        return { analytics, statusLabels: dict.leadStatuses }
      },
    }),

    show_manager_performance: tool({
      description:
        'Производительность менеджеров: диалоги, ответы, конверсия. Используй для вопросов «кто лучше работает», «у кого просадка».',
      inputSchema: z.object({}),
      execute: async () => {
        const perf = await cached('manager-performance', getManagerPerformance)
        state.views.push({
          kind: 'stats',
          title: 'Производительность менеджеров',
          payload: perf,
        })
        return perf
      },
    }),
  }
}
