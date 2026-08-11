'use server'

/**
 * Статистика и дисциплина по лидам + справочники (города, должности).
 * Часть распила app/actions/lead-cards.ts.
 */
import { getSession, requireAdmin, requireCurator } from '@/lib/auth'
import {
  getCuratorDiscipline,
  listLeadCardsForCurator,
} from '@/lib/data/lead-cards'
import { searchCitiesWithRegions } from '@/lib/data/regions'
import { addVacancy, listVacancies } from '@/lib/data/vacancies'
import {
  getLeadCardStats,
  listLeadCardsForManager,
  type ManagerLeadFilterStatus,
} from '@/lib/data/lead-stats'
import {
  isLeadStatus,
  isPastDailyDeadline,
  leadNeedsDailyStatus,
} from '@/lib/lead-status'
import { mskDayKey } from '@/lib/time'
import {
  requireManagerOrAdmin,
  type LeadCardActionResult,
} from './shared'

/** Curator daily gate payload (used by the workspace to re-check live). */
export async function getCuratorStatusGateAction() {
  const session = await requireCurator()
  const leads = await listLeadCardsForCurator(session.sub)
  const pending = leads.filter((l) => leadNeedsDailyStatus(l))
  return {
    total: leads.length,
    pendingCount: pending.length,
    pendingIds: pending.map((l) => l.id),
    locked: isPastDailyDeadline() && pending.length > 0,
    today: mskDayKey(new Date()),
  }
}

/* ------------------- Справочники: города+регионы, должности ------------------- */

/** Автодополнение «город (регион)» — доступно админу и менеджерам. */
export async function searchCityAction(q: string) {
  await requireManagerOrAdmin()
  if (!q || q.trim().length < 1) return []
  return searchCitiesWithRegions(q, 12)
}

/** Список должностей из справочника. */
export async function listVacanciesAction() {
  await requireManagerOrAdmin()
  return listVacancies()
}

/** Добавить должность в справочник (без хардкода в коде). */
export async function addVacancyAction(
  name: string,
): Promise<LeadCardActionResult & { vacancy?: { id: string; name: string } }> {
  await requireAdmin()
  try {
    const v = await addVacancy(name)
    return {
      ok: true,
      message: 'Должность добавлена',
      vacancy: { id: v.id, name: v.name },
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}

/* ------------------------- Lead-card statistics ------------------------- */

/** Manager: stats over HIS lead cards for a period / single day (MSK). */
export async function getMyLeadCardStatsAction(filter: {
  from?: string | null
  to?: string | null
}) {
  const session = await getSession()
  if (!session || session.role !== 'manager') throw new Error('Forbidden')
  return getLeadCardStats({
    managerId: session.sub,
    from: filter.from ?? null,
    to: filter.to ?? null,
  })
}

/** Manager: HIS lead cards with period + status filters («Передан» etc.). */
export async function listMyLeadCardsAction(filter: {
  from?: string | null
  to?: string | null
  status?: string | null
  limit?: number
  offset?: number
}) {
  const session = await getSession()
  if (!session || session.role !== 'manager') throw new Error('Forbidden')
  const status: ManagerLeadFilterStatus =
    filter.status === 'transferred' ||
    filter.status === 'not_transferred' ||
    filter.status === 'none'
      ? filter.status
      : isLeadStatus(filter.status)
        ? filter.status
        : null
  return listLeadCardsForManager(session.sub, {
    from: filter.from ?? null,
    to: filter.to ?? null,
    status,
    limit: filter.limit,
    offset: filter.offset,
  })
}

/** Admin: lead-card stats by dates, optionally scoped to manager/curator. */
export async function getLeadCardStatsAdminAction(filter: {
  from?: string | null
  to?: string | null
  managerId?: string | null
  curatorId?: string | null
}) {
  await requireAdmin()
  return getLeadCardStats({
    managerId: filter.managerId ?? null,
    curatorId: filter.curatorId ?? null,
    from: filter.from ?? null,
    to: filter.to ?? null,
  })
}

/** Admin: per-curator discipline snapshot for today. */
export async function getCuratorDisciplineAction() {
  await requireAdmin()
  return getCuratorDiscipline()
}
