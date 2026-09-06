'use server'

/**
 * Server actions для финансов источника трафика: депозиты (бюджеты) и дневной
 * лог трат. Строгие скоуп-гейты:
 *   - Байер: работает ТОЛЬКО со своими источниками (buyer_id = session.sub),
 *     ведёт траты, подтверждает/отклоняет депозиты. Депозиты не вносит.
 *   - Админ: вносит депозиты и читает отчётность по любому байеру.
 *   - Руководитель (head): то же, но ТОЛЬКО по байерам своей команды
 *     (isBuyerOfHead перечитывается из БД на каждый запрос).
 */
import { revalidatePath } from 'next/cache'
import { requireBuyer, getSession } from '@/lib/auth'
import { isBuyerOfHead, listBuyerIdsOfHead } from '@/lib/data/heads'
import {
  getTrafficSourceById,
  getBuyerIdForSource,
  listBuyers,
  listTrafficSourcesForBuyer,
} from '@/lib/data/traffic-sources'
import { getManagerById } from '@/lib/data/managers'
import {
  createDeposit,
  decideDeposit,
  deleteSpendDay,
  getBuyerFinanceTotals,
  getSourceFinanceSummary,
  getSummariesForSources,
  listDeposits,
  listSpendDays,
  upsertSpendDay,
  type DepositStatus,
} from '@/lib/data/source-finance'

/* ----------------------------- Скоуп-хелперы ---------------------------- */

/** Гарантирует, что источник принадлежит текущему байеру. Возвращает buyerId. */
async function assertBuyerOwnsSource(sourceId: string): Promise<string> {
  const session = await requireBuyer()
  const ownerId = await getBuyerIdForSource(sourceId)
  if (!ownerId || ownerId !== session.sub) {
    throw new Error('Источник не найден или принадлежит другому байеру.')
  }
  return session.sub
}

/**
 * Гарантирует, что текущий пользователь (admin или head своей команды) вправе
 * вносить депозит/читать отчётность байера источника. Возвращает контекст.
 */
async function assertCanManageSourceFinance(sourceId: string): Promise<{
  actorId: string | null
  actorKind: 'admin' | 'head'
  buyerId: string | null
}> {
  const session = await getSession()
  if (!session) throw new Error('Не авторизован.')
  const buyerId = await getBuyerIdForSource(sourceId)
  if (session.role === 'admin') {
    return { actorId: null, actorKind: 'admin', buyerId }
  }
  if (session.role === 'head') {
    if (!buyerId || !(await isBuyerOfHead(session.sub, buyerId))) {
      throw new Error('Байер этого источника не входит в вашу команду.')
    }
    return { actorId: session.sub, actorKind: 'head', buyerId }
  }
  throw new Error('Недостаточно прав.')
}

/* -------------------------------- Байер -------------------------------- */

/** Полная финансовая картина источника (для байера-владельца). */
export async function getBuyerSourceFinanceAction(sourceId: string) {
  await assertBuyerOwnsSource(sourceId)
  const [summary, deposits, spend] = await Promise.all([
    getSourceFinanceSummary(sourceId),
    listDeposits(sourceId),
    listSpendDays(sourceId),
  ])
  return { summary, deposits, spend }
}

/** Байер подтверждает или отклоняет депозит (отклонение — с причиной). */
export async function decideDepositAction(input: {
  depositId: string
  sourceId: string
  decision: Exclude<DepositStatus, 'pending'>
  note?: string
}) {
  const buyerId = await assertBuyerOwnsSource(input.sourceId)
  const deposit = await decideDeposit({
    depositId: input.depositId,
    buyerId,
    decision: input.decision,
    note: input.note,
  })
  revalidatePath('/buyer')
  return deposit
}

/** Байер вносит/обновляет траты за день (upsert). */
export async function upsertSpendDayAction(input: {
  sourceId: string
  spendDate: string
  spend: number
  impressions?: number
  clicks?: number
  leads?: number
  note?: string
}) {
  const buyerId = await assertBuyerOwnsSource(input.sourceId)
  const row = await upsertSpendDay({ ...input, buyerId })
  revalidatePath('/buyer')
  return row
}

/** Байер удаляет запись трат за день. */
export async function deleteSpendDayAction(input: {
  id: string
  sourceId: string
}) {
  const buyerId = await assertBuyerOwnsSource(input.sourceId)
  await deleteSpendDay(input.id, buyerId)
  revalidatePath('/buyer')
}

/* --------------------------- Админ / Руководитель --------------------------- */

/** Отчётность источника для админа/руководителя (read-oriented). */
export async function getSourceFinanceReportAction(sourceId: string) {
  await assertCanManageSourceFinance(sourceId)
  const [summary, deposits, spend, source] = await Promise.all([
    getSourceFinanceSummary(sourceId),
    listDeposits(sourceId),
    listSpendDays(sourceId),
    getTrafficSourceById(sourceId),
  ])
  return { summary, deposits, spend, source }
}

/**
 * Внести депозит (бюджет) байеру. Сумма вводится в orig_currency и приводится
 * к базовой валюте источника по fxRate. Приходит в статусе pending — байер
 * должен подтвердить и отчитаться.
 */
export async function createDepositAction(input: {
  sourceId: string
  origAmount: number
  origCurrency: string
  fxRate: number
  purpose?: string
}) {
  const ctx = await assertCanManageSourceFinance(input.sourceId)
  const deposit = await createDeposit({
    sourceId: input.sourceId,
    buyerId: ctx.buyerId,
    createdBy: ctx.actorId,
    createdByKind: ctx.actorKind,
    origAmount: input.origAmount,
    origCurrency: input.origCurrency,
    fxRate: input.fxRate,
    purpose: input.purpose,
  })
  revalidatePath('/admin/buyers')
  revalidatePath('/head/buyers')
  revalidatePath('/buyer')
  return deposit
}

/* ------------------- Отчётность по байеру (admin/head) ------------------- */

/**
 * Список байеров с финансовыми итогами. Админ видит всех, руководитель — только
 * байеров своей команды (скоуп перечитывается из БД). Общий бэкенд для
 * /admin/buyers и /head/buyers.
 */
export async function listBuyersWithTotalsAction() {
  const session = await getSession()
  if (!session) throw new Error('Не авторизован.')
  let buyers = await listBuyers()
  if (session.role === 'head') {
    const allowed = new Set(await listBuyerIdsOfHead(session.sub))
    buyers = buyers.filter((b) => allowed.has(b.id))
  } else if (session.role !== 'admin') {
    throw new Error('Недостаточно прав.')
  }
  const withTotals = await Promise.all(
    buyers.map(async (b) => ({
      buyer: b,
      totals: await getBuyerFinanceTotals(b.id),
    })),
  )
  return { buyers: withTotals }
}

/**
 * Полная отчётность по одному байеру: его источники со сводками. Скоуп: админ —
 * любой байер, руководитель — только свой (иначе ошибка).
 */
export async function getBuyerReportAction(buyerId: string) {
  const session = await getSession()
  if (!session) throw new Error('Не авторизован.')
  if (session.role === 'head') {
    if (!(await isBuyerOfHead(session.sub, buyerId))) {
      throw new Error('Этот байер не входит в вашу команду.')
    }
  } else if (session.role !== 'admin') {
    throw new Error('Недостаточно прав.')
  }
  const [buyer, sources, totals] = await Promise.all([
    getManagerById(buyerId),
    listTrafficSourcesForBuyer(buyerId),
    getBuyerFinanceTotals(buyerId),
  ])
  const summaries = await getSummariesForSources(sources.map((s) => s.id))
  return {
    buyer,
    totals,
    sources: sources.map((s) => ({
      source: s,
      summary: summaries.get(s.id) ?? null,
    })),
  }
}
