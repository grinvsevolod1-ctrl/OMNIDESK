'use server'

/**
 * Раздел медиабайера (/buyer): чтение СВОИХ источников, статистики и лидов.
 * Скоуп каждого запроса — строго buyer_id = session.sub; байер ничего не
 * редактирует (read-only по дизайну первой итерации).
 */
import { requireBuyer } from '@/lib/auth'
import {
  getSourceStats,
  listLeadCardsForBuyer,
  listTrafficSourcesForBuyer,
  type SourceStats,
  type TrafficSource,
} from '@/lib/data/traffic-sources'
import type { LeadCard } from '@/lib/data/lead-cards-core'

export interface BuyerSourceOverview extends TrafficSource {
  stats: SourceStats
}

/** Обзор байера: его источники со статистикой день/«долёты». */
export async function listBuyerSourcesAction(): Promise<
  BuyerSourceOverview[]
> {
  const session = await requireBuyer()
  const sources = await listTrafficSourcesForBuyer(session.sub)
  const stats = await getSourceStats(sources.map((s) => s.id))
  return sources.map((s) => ({
    ...s,
    stats: stats.get(s.id) ?? {
      sourceId: s.id,
      total: 0,
      todayTotal: 0,
      todayDay: 0,
      todayNight: 0,
    },
  }))
}

/** Лиды всех источников байера (read-only, фильтры/поиск — на клиенте). */
export async function listBuyerLeadsAction(): Promise<LeadCard[]> {
  const session = await requireBuyer()
  return listLeadCardsForBuyer(session.sub)
}
