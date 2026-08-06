import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  getCuratorDiscipline,
  listActiveCurators,
  listAllTransferredLeads,
  listLeadCardsForCurator,
} from '@/lib/data/lead-cards'
import { LEAD_STATUS_LABELS, isLeadStatus } from '@/lib/lead-status'
import type { RunState } from './run-state'

/**
 * Read-only curator observability for the co-pilot: who the curators are, how
 * loaded they are, whether they keep the daily status discipline, and what is
 * happening with transferred leads. All read-only — managing curators
 * (create/block) stays in the admin UI.
 */
export function curatorTools(_state: RunState) {
  return {
    listCurators: tool({
      description:
        'Показать всех активных кураторов: имя, город и текущая нагрузка (сколько активных лидов у каждого). Вызывай, когда админ спрашивает «какие у нас кураторы», «кто ведёт Казань», «кто самый загруженный», «кому можно отдать лида».',
      inputSchema: z.object({}),
      execute: async () => {
        const curators = await listActiveCurators()
        return {
          ok: true,
          count: curators.length,
          curators: curators.map((c) => ({
            name: c.name,
            city: c.city,
            activeLeads: c.activeLeads,
          })),
        }
      },
    }),

    curatorDiscipline: tool({
      description:
        'Сводка дисциплины кураторов на сегодня: сколько лидов у каждого, сколько статусов подтверждено сегодня, сколько просрочено, распределение по статусам («В работе», «Игнор», «Кинул»…). Вызывай, когда админ спрашивает «как дела у кураторов», «кто не обновил статусы», «как дисциплина», «что по лидам у кураторов».',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await getCuratorDiscipline()
        return {
          ok: true,
          curators: rows.map((d) => ({
            name: d.curatorName,
            city: d.city,
            totalLeads: d.totalLeads,
            confirmedToday: d.confirmedToday,
            pendingToday: d.pendingToday,
            statuses: Object.fromEntries(
              Object.entries(d.statusCounts).map(([k, v]) => [
                isLeadStatus(k) ? LEAD_STATUS_LABELS[k] : k,
                v,
              ]),
            ),
          })),
        }
      },
    }),

    curatorLeads: tool({
      description:
        'Лиды конкретного куратора (по имени) или все переданные лиды с фильтрами по статусу и городу — включая «осиротевшие» лиды без куратора. Вызывай, когда админ спрашивает «покажи лиды Марии», «сколько лидов в работе по Москве», «есть ли лиды без куратора».',
      inputSchema: z.object({
        curatorName: z
          .string()
          .optional()
          .describe('Имя куратора (частичное совпадение), если спрашивают про конкретного'),
        status: z
          .string()
          .optional()
          .describe(
            'Фильтр по статусу: awaiting_exit, training, working, temporarily_off, refused, ignore, left или none (без статуса)',
          ),
        city: z.string().optional().describe('Фильтр по городу лида'),
        orphanedOnly: z
          .boolean()
          .optional()
          .describe('true — только лиды без куратора (осиротевшие)'),
      }),
      execute: async ({ curatorName, status, city, orphanedOnly }) => {
        let curatorId: string | null = null
        let matchedCurator: string | null = null
        if (curatorName?.trim()) {
          const all = await listActiveCurators()
          const q = curatorName.trim().toLowerCase()
          const found = all.find((c) => c.name.toLowerCase().includes(q))
          if (!found) {
            return {
              ok: false,
              error: `Куратор с именем «${curatorName}» не найден. Доступны: ${all.map((c) => c.name).join(', ') || 'никого'}.`,
            }
          }
          curatorId = found.id
          matchedCurator = found.name
        }

        if (curatorId && !status && !city && !orphanedOnly) {
          const leads = await listLeadCardsForCurator(curatorId)
          return {
            ok: true,
            curator: matchedCurator,
            total: leads.length,
            leads: leads.slice(0, 30).map((l) => ({
              name: l.fullName,
              city: l.city,
              status: l.status ? LEAD_STATUS_LABELS[l.status] : 'Не указан',
              confirmedDate: l.statusConfirmedDate,
            })),
          }
        }

        const res = await listAllTransferredLeads({
          curatorId,
          status:
            status === 'none' ? 'none' : isLeadStatus(status) ? status : null,
          city: city ?? null,
          orphanedOnly: Boolean(orphanedOnly),
          limit: 30,
        })
        return {
          ok: true,
          curator: matchedCurator,
          total: res.total,
          shown: res.leads.length,
          leads: res.leads.map((l) => ({
            name: l.fullName,
            city: l.city,
            curator: l.curatorName ?? 'БЕЗ КУРАТОРА',
            status: l.status ? LEAD_STATUS_LABELS[l.status] : 'Не указан',
          })),
        }
      },
    }),
  }
}
