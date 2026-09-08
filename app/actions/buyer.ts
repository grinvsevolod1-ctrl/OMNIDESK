'use server'

/**
 * Раздел медиабайера (/buyer): чтение СВОИХ источников, статистики и лидов.
 * Скоуп каждого запроса — строго buyer_id = session.sub; байер ничего не
 * редактирует (read-only по дизайну первой итерации).
 */
import { revalidatePath } from 'next/cache'
import { requireBuyer } from '@/lib/auth'
import {
  createTrafficSourceForBuyer,
  getBuyerIdForSource,
  getSourceStats,
  getTrafficSourceById,
  listLeadCardsForBuyer,
  listTrafficSourcesForBuyer,
  updateTrafficSourceByBuyer,
  type SourceStats,
  type TrafficSource,
} from '@/lib/data/traffic-sources'
import {
  getSummariesForSources,
  type SourceFinanceSummary,
} from '@/lib/data/source-finance'
import type { LeadCard } from '@/lib/data/lead-cards-core'

export interface BuyerSourceOverview extends TrafficSource {
  stats: SourceStats
  finance: SourceFinanceSummary
}

/** Обзор байера: его источники со статистикой написавших/переданных и финсводкой. */
export async function listBuyerSourcesAction(): Promise<
  BuyerSourceOverview[]
> {
  const session = await requireBuyer()
  const sources = await listTrafficSourcesForBuyer(session.sub)
  const ids = sources.map((s) => s.id)
  const [stats, finance] = await Promise.all([
    getSourceStats(ids),
    getSummariesForSources(ids),
  ])
  return sources.map((s) => ({
    ...s,
    stats: stats.get(s.id) ?? {
      sourceId: s.id,
      total: 0,
      todayTotal: 0,
      transferredTotal: 0,
      transferredToday: 0,
    },
    finance: finance.get(s.id) ?? {
      sourceId: s.id,
      currency: s.currency ?? 'RUB',
      confirmedDeposits: 0,
      pendingDeposits: 0,
      totalSpend: 0,
      balance: 0,
      utilization: 0,
      impressions: 0,
      clicks: 0,
      leads: 0,
      ctr: 0,
      cr: 0,
      cpl: Number.POSITIVE_INFINITY,
      pendingCount: 0,
    },
  }))
}

/** Лиды всех источников байера (read-only, фильтры/поиск — на клиенте). */
export async function listBuyerLeadsAction(): Promise<LeadCard[]> {
  const session = await requireBuyer()
  return listLeadCardsForBuyer(session.sub)
}

/**
 * Байер создаёт источник из каталога (единый путь создания источника). Владелец
 * фиксируется на текущего байера; платформа/валюта берутся из выбранной карточки.
 */
export async function createBuyerSourceAction(input: {
  name: string
  platformKey: string
  currency: string
  externalAccount?: string
  notes?: string | null
}): Promise<TrafficSource> {
  const session = await requireBuyer()
  const source = await createTrafficSourceForBuyer({
    buyerId: session.sub,
    name: input.name,
    platformKey: input.platformKey,
    currency: input.currency,
    externalAccount: input.externalAccount,
    notes: input.notes,
  })
  revalidatePath('/buyer')
  return source
}

/** Байер редактирует настройки своего источника (скоуп по владельцу). */
export async function updateBuyerSourceAction(input: {
  id: string
  name: string
  externalAccount?: string
  notes?: string | null
}): Promise<TrafficSource> {
  const session = await requireBuyer()
  const owner = await getBuyerIdForSource(input.id)
  if (owner !== session.sub) {
    throw new Error('Источник не найден или принадлежит другому байеру.')
  }
  const source = await updateTrafficSourceByBuyer({ ...input, buyerId: session.sub })
  revalidatePath('/buyer')
  return source
}

/** Один источник байера (для детальной страницы), со скоупом по владельцу. */
export async function getBuyerSourceAction(
  id: string,
): Promise<TrafficSource | null> {
  const session = await requireBuyer()
  const owner = await getBuyerIdForSource(id)
  if (owner !== session.sub) return null
  return getTrafficSourceById(id)
}
