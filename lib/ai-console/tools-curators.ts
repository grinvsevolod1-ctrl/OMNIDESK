import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  getCuratorDiscipline,
  getCuratorDisciplineHistory,
  listActiveCurators,
  listAllTransferredLeads,
  listLeadCardsForCurator,
} from '@/lib/data/lead-cards'
import {
  findSlaBreaches,
  getLeadSlaSettings,
  updateLeadSlaSettings,
} from '@/lib/data/lead-sla'
import { LEAD_STATUS_LABELS, isLeadStatus } from '@/lib/lead-status'
import type { RunState } from './run-state'

/**
 * Curator observability + lead-lifecycle SLA for the co-pilot: who the
 * curators are, how loaded they are, whether they keep the daily status
 * discipline, what is happening with transferred leads, and the chat-managed
 * lifecycle thresholds (auto-archive + stuck-lead escalations, migration 117).
 * Managing curators themselves (create/block) stays in the admin UI.
 */
export function curatorTools(_state: RunState) {
  return {
    listCurators: tool({
      description:
        'Показать всех активных кураторов: имя, города (куратор может вести несколько городов) и текущая нагрузка (сколько активных лидов у каждого). Вызывай, когда админ спрашивает «какие у нас кураторы», «кто ведёт Казань», «кто самый загруженный», «кому можно отдать лида».',
      inputSchema: z.object({}),
      execute: async () => {
        const curators = await listActiveCurators()
        return {
          ok: true,
          count: curators.length,
          curators: curators.map((c) => ({
            name: c.name,
            cities: c.cities.length ? c.cities : c.city ? [c.city] : [],
            activeLeads: c.activeLeads,
          })),
        }
      },
    }),

    curatorDiscipline: tool({
      description:
        'Сводка дисциплины кураторов: сегодня (сколько лидов, сколько статусов подтверждено, сколько просрочено, распределение по статусам) плюс история за 30 дней — процент подтверждений, сделанных вовремя (до 10:00 МСК). Вызывай, когда админ спрашивает «как дела у кураторов», «кто не обновил статусы», «как дисциплина», «кто стабильно опаздывает».',
      inputSchema: z.object({}),
      execute: async () => {
        const [rows, history] = await Promise.all([
          getCuratorDiscipline(),
          getCuratorDisciplineHistory(30).catch(() => new Map()),
        ])
        return {
          ok: true,
          curators: rows.map((d) => {
            const h = history.get(d.curatorId)
            return {
              name: d.curatorName,
              city: d.city,
              totalLeads: d.totalLeads,
              confirmedToday: d.confirmedToday,
              pendingToday: d.pendingToday,
              last30Days: h
                ? {
                    onTimeRatePct: h.onTimeRatePct,
                    totalConfirms: h.totalConfirms,
                    activeDays: h.activeDays,
                  }
                : null,
              statuses: Object.fromEntries(
                Object.entries(d.statusCounts).map(([k, v]) => [
                  isLeadStatus(k) ? LEAD_STATUS_LABELS[k] : k,
                  v,
                ]),
              ),
            }
          }),
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

    getLeadLifecycle: tool({
      description:
        'Жизненный цикл лидов: текущие SLA-настройки (через сколько дней финальные лиды «Отказался»/«Кинул» уходят в архив, когда эскалировать зависших в «Игнор» и «Ожидает выхода») и список лидов, которые прямо сейчас превысили пороги. Вызывай, когда админ спрашивает «какие лиды зависли», «кто давно в игноре», «что с архивом», «какие пороги эскалации».',
      inputSchema: z.object({}),
      execute: async () => {
        const settings = await getLeadSlaSettings()
        const breaches = await findSlaBreaches(settings).catch(() => [])
        return {
          ok: true,
          settings: {
            archiveAfterDays: settings.archiveAfterDays,
            ignoreAlertDays: settings.ignoreAlertDays,
            awaitingExitAlertDays: settings.awaitingExitAlertDays,
            hint: 'Значение 0 отключает соответствующее правило.',
          },
          stuckLeads: breaches.slice(0, 30).map((b) => ({
            name: b.fullName,
            city: b.city,
            status: LEAD_STATUS_LABELS[b.status],
            curator: b.curatorName ?? 'БЕЗ КУРАТОРА',
            daysInStatus: b.daysInStatus,
            threshold: b.thresholdDays,
          })),
          totalStuck: breaches.length,
        }
      },
    }),

    configureLeadSla: tool({
      description:
        'Изменить SLA-пороги жизненного цикла лидов: archiveAfterDays — через сколько дней финальный лид («Отказался»/«Кинул») автоматически уходит в архив (0 — не архивировать автоматически); ignoreAlertDays — через сколько дней в «Игноре» эскалировать куратору (0 — выкл); awaitingExitAlertDays — то же для «Ожидает выхода». Вызывай на фразы «архивируй кинутых через неделю», «напоминай про игнор через 3 дня», «отключи авто-архив». Передавай только те поля, которые админ просил поменять.',
      inputSchema: z.object({
        archiveAfterDays: z.number().int().min(0).max(365).optional(),
        ignoreAlertDays: z.number().int().min(0).max(365).optional(),
        awaitingExitAlertDays: z.number().int().min(0).max(365).optional(),
      }),
      execute: async (patch) => {
        if (
          patch.archiveAfterDays === undefined &&
          patch.ignoreAlertDays === undefined &&
          patch.awaitingExitAlertDays === undefined
        ) {
          return {
            ok: false,
            error: 'Не передано ни одного параметра для изменения.',
          }
        }
        const before = await getLeadSlaSettings()
        const after = await updateLeadSlaSettings(patch)
        const parts: string[] = []
        if (before.archiveAfterDays !== after.archiveAfterDays) {
          parts.push(
            after.archiveAfterDays === 0
              ? 'авто-архив выключен'
              : `авто-архив финальных через ${after.archiveAfterDays} дн.`,
          )
        }
        if (before.ignoreAlertDays !== after.ignoreAlertDays) {
          parts.push(
            after.ignoreAlertDays === 0
              ? 'эскалация «Игнор» выключена'
              : `эскалация «Игнор» через ${after.ignoreAlertDays} дн.`,
          )
        }
        if (before.awaitingExitAlertDays !== after.awaitingExitAlertDays) {
          parts.push(
            after.awaitingExitAlertDays === 0
              ? 'эскалация «Ожидает выхода» выключена'
              : `эскалация «Ожидает выхода» через ${after.awaitingExitAlertDays} дн.`,
          )
        }
        _state.actions.push({
          kind: 'followup',
          label: `SLA лидов: ${parts.join('; ') || 'без изменений'}`,
        })
        return { ok: true, settings: after, changed: parts }
      },
    }),
  }
}
