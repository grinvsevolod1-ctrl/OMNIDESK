/**
 * Финансы источника трафика (миграция 165): депозиты (бюджеты) и дневной лог
 * трат байера. Единый источник правды — traffic_sources; депозиты вносит
 * админ/руководитель, байер их подтверждает/отклоняет и ведёт ежедневный расход.
 *
 * Денежная модель (референс — старая admin-only finance_ad_*, но привязка к
 * байеру и его источникам):
 *   Баланс источника = Σ(подтверждённых депозитов) − Σ(трат), в БАЗОВОЙ валюте
 *   источника (traffic_sources.currency, обычно RUB).
 *
 * Мультивалюта: депозит можно ввести в любой валюте — фиксируем orig_amount /
 * orig_currency / fx_rate и сохраняем amount, уже приведённый к базовой валюте
 * источника (заморозка курса, как в finance_entries, миграция 059). Пересчёта
 * задним числом нет.
 */
import 'server-only'
import { randomUUID } from 'crypto'
import { query } from '../db'
import type { FinanceCurrency } from '../finance-types'
import { mskDayKey } from '../time'
import {
  reportWindowDays,
  sqlMskRange,
  type SourceReportRange,
} from './traffic-sources'

/* -------------------------------- Типы -------------------------------- */

export type DepositStatus = 'pending' | 'confirmed' | 'rejected'
export type DepositAuthorKind = 'admin' | 'head'

export interface SourceDeposit {
  id: string
  sourceId: string
  buyerId: string | null
  createdBy: string | null
  createdByKind: DepositAuthorKind
  createdByName: string | null
  /** Сумма в базовой валюте источника (уже сконвертирована). */
  amount: number
  /** FX-заморозка: сумма/валюта ввода + курс к базовой на момент внесения. */
  origAmount: number
  origCurrency: string
  fxRate: number
  purpose: string
  status: DepositStatus
  buyerNote: string
  decidedAt: string | null
  createdAt: string
}

export interface SourceSpendDay {
  id: string
  sourceId: string
  buyerId: string | null
  spendDate: string
  spend: number
  impressions: number
  clicks: number
  leads: number
  note: string
  createdAt: string
  updatedAt: string
}

/** Сводка баланса и метрик источника — считается из леджера и лога трат. */
export interface SourceFinanceSummary {
  sourceId: string
  currency: string
  /** Σ подтверждённых депозитов. */
  confirmedDeposits: number
  /** Σ депозитов в статусе pending (ждут решения байера). */
  pendingDeposits: number
  /** Σ трат из дневного лога. */
  totalSpend: number
  /** Баланс = confirmedDeposits − totalSpend. */
  balance: number
  /** Освоение подтверждённого бюджета, % (spend / confirmed). */
  utilization: number
  impressions: number
  clicks: number
  leads: number
  ctr: number
  cr: number
  cpl: number
  /** Кол-во депозитов, ждущих решения. */
  pendingCount: number
}

/* ------------------------------- Мапперы ------------------------------ */

interface DepositRow {
  id: string
  source_id: string
  buyer_id: string | null
  created_by: string | null
  created_by_kind: DepositAuthorKind
  created_by_name: string | null
  amount: string | number
  orig_amount: string | number
  orig_currency: string
  fx_rate: string | number
  purpose: string
  status: DepositStatus
  buyer_note: string
  decided_at: string | Date | null
  created_at: string | Date
}

const num = (v: string | number): number =>
  typeof v === 'number' ? v : Number.parseFloat(v || '0')

function toDeposit(row: DepositRow): SourceDeposit {
  return {
    id: row.id,
    sourceId: row.source_id,
    buyerId: row.buyer_id,
    createdBy: row.created_by,
    createdByKind: row.created_by_kind,
    createdByName: row.created_by_name,
    amount: num(row.amount),
    origAmount: num(row.orig_amount),
    origCurrency: row.orig_currency,
    fxRate: num(row.fx_rate),
    purpose: row.purpose,
    status: row.status,
    buyerNote: row.buyer_note,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

interface SpendRow {
  id: string
  source_id: string
  buyer_id: string | null
  spend_date: string | Date
  spend: string | number
  impressions: string | number
  clicks: string | number
  leads: string | number
  note: string
  created_at: string | Date
  updated_at: string | Date
}

function toSpendDay(row: SpendRow): SourceSpendDay {
  return {
    id: row.id,
    sourceId: row.source_id,
    buyerId: row.buyer_id,
    spendDate:
      typeof row.spend_date === 'string'
        ? row.spend_date.slice(0, 10)
        : new Date(row.spend_date).toISOString().slice(0, 10),
    spend: num(row.spend),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    leads: Number(row.leads),
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

const DEPOSIT_SELECT = `
  d.id, d.source_id, d.buyer_id, d.created_by, d.created_by_kind,
  a.name AS created_by_name, d.amount, d.orig_amount, d.orig_currency,
  d.fx_rate, d.purpose, d.status, d.buyer_note, d.decided_at, d.created_at`

/* ------------------------------ Депозиты ------------------------------ */

/** Депозиты источника, свежие сверху. */
export async function listDeposits(sourceId: string): Promise<SourceDeposit[]> {
  const rows = await query<DepositRow>(
    `SELECT ${DEPOSIT_SELECT}
       FROM source_deposits d
       LEFT JOIN managers a ON a.id = d.created_by
      WHERE d.source_id = $1
      ORDER BY d.created_at DESC`,
    [sourceId],
  )
  return rows.map(toDeposit)
}

/**
 * Внести депозит (админ/руководитель). Сумма вводится в orig_currency и
 * приводится к базовой валюте источника по переданному курсу fxRate
 * (USD-за-1-единицу для обеих валют уже учтён вызывающим — здесь fxRate это
 * «сколько базовой валюты стоит 1 единица orig_currency»). Приходит pending.
 */
export async function createDeposit(input: {
  sourceId: string
  buyerId: string | null
  createdBy: string | null
  createdByKind: DepositAuthorKind
  origAmount: number
  origCurrency: string
  fxRate: number
  purpose?: string
}): Promise<SourceDeposit> {
  if (!(input.origAmount > 0)) throw new Error('Сумма должна быть больше нуля.')
  if (!(input.fxRate > 0)) throw new Error('Некорректный курс валюты.')
  const amount = Math.round(input.origAmount * input.fxRate * 100) / 100
  const id = randomUUID()
  await query(
    `INSERT INTO source_deposits
       (id, source_id, buyer_id, created_by, created_by_kind, amount,
        orig_amount, orig_currency, fx_rate, purpose, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
    [
      id,
      input.sourceId,
      input.buyerId,
      input.createdBy,
      input.createdByKind,
      amount,
      input.origAmount,
      input.origCurrency.trim().toUpperCase() || 'RUB',
      input.fxRate,
      input.purpose?.trim() || '',
    ],
  )
  const rows = await query<DepositRow>(
    `SELECT ${DEPOSIT_SELECT}
       FROM source_deposits d
       LEFT JOIN managers a ON a.id = d.created_by
      WHERE d.id = $1`,
    [id],
  )
  return toDeposit(rows[0])
}

/**
 * Решение байера по депозиту: 'confirmed' (обязуется освоить) или 'rejected'
 * (с причиной в note). Только из статуса pending; повторное решение отклоняется.
 * Скоуп по buyerId — байер решает только по своим депозитам.
 */
export async function decideDeposit(input: {
  depositId: string
  buyerId: string
  decision: Exclude<DepositStatus, 'pending'>
  note?: string
}): Promise<SourceDeposit> {
  if (input.decision === 'rejected' && !input.note?.trim()) {
    throw new Error('Укажите причину отклонения.')
  }
  const res = await query<{ id: string }>(
    `UPDATE source_deposits
        SET status = $3, buyer_note = $4, decided_at = now()
      WHERE id = $1 AND buyer_id = $2 AND status = 'pending'
      RETURNING id`,
    [input.depositId, input.buyerId, input.decision, input.note?.trim() || ''],
  )
  if (res.length === 0) {
    throw new Error('Депозит не найден, уже обработан или принадлежит другому байеру.')
  }
  const rows = await query<DepositRow>(
    `SELECT ${DEPOSIT_SELECT}
       FROM source_deposits d
       LEFT JOIN managers a ON a.id = d.created_by
      WHERE d.id = $1`,
    [input.depositId],
  )
  return toDeposit(rows[0])
}

/* -------------------------- Дневной лог трат -------------------------- */

/** Дневной лог трат источника, свежие даты сверху. */
export async function listSpendDays(
  sourceId: string,
): Promise<SourceSpendDay[]> {
  const rows = await query<SpendRow>(
    `SELECT id, source_id, buyer_id, spend_date, spend, impressions,
            clicks, leads, note, created_at, updated_at
       FROM source_spend_daily
      WHERE source_id = $1
      ORDER BY spend_date DESC`,
    [sourceId],
  )
  return rows.map(toSpendDay)
}

/**
 * Внести/обновить траты за день (upsert по (source_id, spend_date)). Байер
 * ведёт расход и метрики; один день — одна строка, повторный ввод перезаписывает.
 */
export async function upsertSpendDay(input: {
  sourceId: string
  buyerId: string
  spendDate: string
  spend: number
  impressions?: number
  clicks?: number
  leads?: number
  note?: string
}): Promise<SourceSpendDay> {
  if (input.spend < 0) throw new Error('Расход не может быть отрицательным.')
  const id = randomUUID()
  const rows = await query<SpendRow>(
    `INSERT INTO source_spend_daily
       (id, source_id, buyer_id, spend_date, spend, impressions, clicks, leads, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_id, spend_date) DO UPDATE
        SET spend = EXCLUDED.spend,
            impressions = EXCLUDED.impressions,
            clicks = EXCLUDED.clicks,
            leads = EXCLUDED.leads,
            note = EXCLUDED.note,
            buyer_id = EXCLUDED.buyer_id,
            updated_at = now()
     RETURNING id, source_id, buyer_id, spend_date, spend, impressions,
               clicks, leads, note, created_at, updated_at`,
    [
      id,
      input.sourceId,
      input.buyerId,
      input.spendDate,
      input.spend,
      Math.max(0, Math.trunc(input.impressions ?? 0)),
      Math.max(0, Math.trunc(input.clicks ?? 0)),
      Math.max(0, Math.trunc(input.leads ?? 0)),
      input.note?.trim() || '',
    ],
  )
  return toSpendDay(rows[0])
}

/** Удалить запись трат за день (скоуп по байеру). */
export async function deleteSpendDay(
  id: string,
  buyerId: string,
): Promise<void> {
  await query(
    `DELETE FROM source_spend_daily WHERE id = $1 AND buyer_id = $2`,
    [id, buyerId],
  )
}

/* ------------------------------ Сводка ------------------------------- */

/**
 * Сводка баланса и метрик по одному источнику. Баланс и освоение считаются
 * из ПОДТВЕРЖДЁННЫХ депозитов (pending в баланс не входит, но показывается
 * отдельно). Всё в базовой валюте источника.
 */
export async function getSourceFinanceSummary(
  sourceId: string,
): Promise<SourceFinanceSummary> {
  const [src] = await query<{ currency: string }>(
    `SELECT currency FROM traffic_sources WHERE id = $1 LIMIT 1`,
    [sourceId],
  )
  const [dep] = await query<{
    confirmed: string | number
    pending: string | number
    pending_count: string | number
  }>(
    `SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS confirmed,
        COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
       FROM source_deposits WHERE source_id = $1`,
    [sourceId],
  )
  const [sp] = await query<{
    spend: string | number
    impressions: string | number
    clicks: string | number
    leads: string | number
  }>(
    `SELECT COALESCE(SUM(spend), 0) AS spend,
            COALESCE(SUM(impressions), 0) AS impressions,
            COALESCE(SUM(clicks), 0) AS clicks,
            COALESCE(SUM(leads), 0) AS leads
       FROM source_spend_daily WHERE source_id = $1`,
    [sourceId],
  )
  const confirmedDeposits = num(dep?.confirmed ?? 0)
  const pendingDeposits = num(dep?.pending ?? 0)
  const totalSpend = num(sp?.spend ?? 0)
  const impressions = Number(sp?.impressions ?? 0)
  const clicks = Number(sp?.clicks ?? 0)
  const leads = Number(sp?.leads ?? 0)
  return {
    sourceId,
    currency: src?.currency ?? 'RUB',
    confirmedDeposits,
    pendingDeposits,
    totalSpend,
    balance: Math.round((confirmedDeposits - totalSpend) * 100) / 100,
    utilization:
      confirmedDeposits > 0 ? (totalSpend / confirmedDeposits) * 100 : 0,
    impressions,
    clicks,
    leads,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cr: clicks > 0 ? (leads / clicks) * 100 : 0,
    cpl: leads > 0 ? totalSpend / leads : Number.POSITIVE_INFINITY,
    pendingCount: Number(dep?.pending_count ?? 0),
  }
}

/** Сводки для набора источников (для списков байера/админа) одним проходом. */
export async function getSummariesForSources(
  sourceIds: string[],
): Promise<Map<string, SourceFinanceSummary>> {
  const out = new Map<string, SourceFinanceSummary>()
  if (sourceIds.length === 0) return out
  for (const id of sourceIds) {
    out.set(id, await getSourceFinanceSummary(id))
  }
  return out
}

/** Валюты, поддерживаемые вводом депозита (переиспользуем финансовые). */
export const SOURCE_CURRENCIES: FinanceCurrency[] = ['RUB', 'USD', 'EUR', 'USDT']

/* ----------------------- Агрегаты по байеру ----------------------- */

/** Финансовые итоги в рамках ОДНОЙ базовой валюты источников. */
export interface CurrencyTotals {
  currency: string
  /** Баланс = confirmedDeposits − totalSpend. */
  balance: number
  confirmedDeposits: number
  pendingDeposits: number
  totalSpend: number
}

export interface BuyerFinanceTotals {
  /**
   * Итоги, разбитые по базовой валюте источников. Суммы из РАЗНЫХ валют не
   * складываются в одно число (это и порождало баг «2000 ₽ vs 2000 $») —
   * каждая валюта показывается отдельной строкой. Пусто, если источников нет.
   * Отсортировано по объёму подтверждённых депозитов (крупнейшая валюта первой).
   */
  byCurrency: CurrencyTotals[]
  /** Валютно-независимые счётчики. */
  leads: number
  pendingCount: number
  sourcesCount: number
}

/**
 * Итоги по байеру across всех его источников, сгруппированные по валюте. Депозиты
 * и траты хранятся уже в базовой валюте своего источника, поэтому агрегируем
 * по traffic_sources.currency — ничего не смешивая между валютами.
 */
export async function getBuyerFinanceTotals(
  buyerId: string,
): Promise<BuyerFinanceTotals> {
  const depRows = await query<{
    currency: string
    confirmed: string | number
    pending: string | number
    pending_count: string | number
  }>(
    `SELECT ts.currency,
        COALESCE(SUM(d.amount) FILTER (WHERE d.status = 'confirmed'), 0) AS confirmed,
        COALESCE(SUM(d.amount) FILTER (WHERE d.status = 'pending'), 0) AS pending,
        COUNT(*) FILTER (WHERE d.status = 'pending') AS pending_count
       FROM source_deposits d
       JOIN traffic_sources ts ON ts.id = d.source_id
      WHERE d.buyer_id = $1
      GROUP BY ts.currency`,
    [buyerId],
  )
  const spendRows = await query<{
    currency: string
    spend: string | number
    leads: string | number
  }>(
    `SELECT ts.currency,
        COALESCE(SUM(s.spend), 0) AS spend,
        COALESCE(SUM(s.leads), 0) AS leads
       FROM source_spend_daily s
       JOIN traffic_sources ts ON ts.id = s.source_id
      WHERE s.buyer_id = $1
      GROUP BY ts.currency`,
    [buyerId],
  )
  const srcRows = await query<{ currency: string; n: string | number }>(
    `SELECT currency, COUNT(*) AS n
       FROM traffic_sources WHERE buyer_id = $1 GROUP BY currency`,
    [buyerId],
  )

  const map = new Map<string, CurrencyTotals>()
  const ensure = (currency: string): CurrencyTotals => {
    let e = map.get(currency)
    if (!e) {
      e = {
        currency,
        balance: 0,
        confirmedDeposits: 0,
        pendingDeposits: 0,
        totalSpend: 0,
      }
      map.set(currency, e)
    }
    return e
  }
  // Валюты источников без движений всё равно показываем (баланс 0).
  for (const r of srcRows) ensure(r.currency)
  for (const r of depRows) {
    const e = ensure(r.currency)
    e.confirmedDeposits = num(r.confirmed)
    e.pendingDeposits = num(r.pending)
  }
  for (const r of spendRows) {
    const e = ensure(r.currency)
    e.totalSpend = num(r.spend)
  }

  const byCurrency = [...map.values()]
    .map((e) => ({
      ...e,
      balance: Math.round((e.confirmedDeposits - e.totalSpend) * 100) / 100,
    }))
    .sort(
      (a, b) =>
        b.confirmedDeposits - a.confirmedDeposits ||
        a.currency.localeCompare(b.currency),
    )

  return {
    byCurrency,
    leads: spendRows.reduce((s, r) => s + Number(r.leads), 0),
    pendingCount: depRows.reduce((s, r) => s + Number(r.pending_count), 0),
    sourcesCount: srcRows.reduce((s, r) => s + Number(r.n), 0),
  }
}

/* ------------------- Суточный расход за период (модалка) ------------------- */

export interface SourceSpendReport {
  range: SourceReportRange
  /** Записи расхода за период, свежие даты сверху. */
  days: SourceSpendDay[]
  /** Σ расхода за период (в базовой валюте источника). */
  total: number
  /** Σ расхода за всё время. */
  allTime: number
  currency: string
  /** Показы/клики/лиды из лога трат за период. */
  impressions: number
  clicks: number
  leads: number
  /** Расход по дням за последние 14 дней (МСК), старые слева. */
  daily: { date: string; spend: number }[]
}

/**
 * Отчёт по суточному расходу источника за выбранный период — для модалки
 * «Обзора» (админ/руководитель). Диапазон применяется к дате расхода
 * (`spend_date` — МСК-дата, которую вводит байер). Всё в базовой валюте
 * источника; суммы разных источников тут не смешиваются (один источник).
 */
export async function getSourceSpendReport(
  sourceId: string,
  range: SourceReportRange = 'today',
): Promise<SourceSpendReport> {
  const day = 's.spend_date'
  const windowDays = reportWindowDays(range)
  const windowStart = `(now() AT TIME ZONE 'Europe/Moscow')::date - ${windowDays - 1}`
  const [meta] = await query<{ currency: string }>(
    `SELECT currency FROM traffic_sources WHERE id = $1 LIMIT 1`,
    [sourceId],
  )
  const [days, totals, daily] = await Promise.all([
    query<SpendRow>(
      `SELECT id, source_id, buyer_id, spend_date, spend, impressions,
              clicks, leads, note, created_at, updated_at
         FROM source_spend_daily s
        WHERE source_id = $1 AND ${sqlMskRange(range, day)}
        ORDER BY spend_date DESC`,
      [sourceId],
    ),
    query<{
      total: string | number
      all_time: string | number
      impressions: string | number
      clicks: string | number
      leads: string | number
    }>(
      `SELECT
          COALESCE(SUM(spend) FILTER (WHERE ${sqlMskRange(range, day)}), 0) AS total,
          COALESCE(SUM(spend), 0) AS all_time,
          COALESCE(SUM(impressions) FILTER (WHERE ${sqlMskRange(range, day)}), 0) AS impressions,
          COALESCE(SUM(clicks) FILTER (WHERE ${sqlMskRange(range, day)}), 0) AS clicks,
          COALESCE(SUM(leads) FILTER (WHERE ${sqlMskRange(range, day)}), 0) AS leads
         FROM source_spend_daily s
        WHERE source_id = $1`,
      [sourceId],
    ),
    query<{ d: string; spend: string | number }>(
      `SELECT to_char(spend_date, 'YYYY-MM-DD') AS d, COALESCE(SUM(spend), 0) AS spend
         FROM source_spend_daily s
        WHERE source_id = $1 AND ${day} >= ${windowStart}
        GROUP BY 1`,
      [sourceId],
    ),
  ])
  const axis: string[] = []
  for (let i = windowDays - 1; i >= 0; i--) {
    axis.push(mskDayKey(new Date(Date.now() - i * 86_400_000)))
  }
  const byDay = new Map(daily.map((r) => [r.d, num(r.spend)]))
  return {
    range,
    days: days.map(toSpendDay),
    total: num(totals[0]?.total ?? 0),
    allTime: num(totals[0]?.all_time ?? 0),
    currency: meta?.currency ?? 'RUB',
    impressions: Number(totals[0]?.impressions ?? 0),
    clicks: Number(totals[0]?.clicks ?? 0),
    leads: Number(totals[0]?.leads ?? 0),
    daily: axis.map((d) => ({ date: d, spend: byDay.get(d) ?? 0 })),
  }
}
