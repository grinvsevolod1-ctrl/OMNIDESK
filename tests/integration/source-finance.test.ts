import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Integration test: финансы источника трафика (миграция 165).
 *
 * Проверяем инварианты, которые unit-тесты покрыть не могут:
 *  - баланс = Σ(подтверждённых депозитов) − Σ(трат);
 *  - pending-депозит НЕ входит в баланс, отражается отдельно;
 *  - решение байера меняет статус только из pending и только по своему депозиту;
 *  - дневной лог трат — upsert по (source_id, spend_date) (уникальный индекс);
 *  - FX-заморозка: amount = orig_amount × fx_rate сохраняется в базовой валюте.
 *
 * Требует DATABASE_URL. Иначе suite пропускается.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe.skipIf(!HAS_DB)('Source finance (deposits + spend)', () => {
  let query: typeof import('@/lib/db').query
  let closePool: typeof import('@/lib/db').closePool
  let createDeposit: typeof import('@/lib/data/source-finance').createDeposit
  let decideDeposit: typeof import('@/lib/data/source-finance').decideDeposit
  let upsertSpendDay: typeof import('@/lib/data/source-finance').upsertSpendDay
  let getSourceFinanceSummary: typeof import('@/lib/data/source-finance').getSourceFinanceSummary

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let buyerId: string
  let otherBuyerId: string
  let sourceId: string

  beforeAll(async () => {
    ;({ query, closePool } = await import('@/lib/db'))
    ;({
      createDeposit,
      decideDeposit,
      upsertSpendDay,
      getSourceFinanceSummary,
    } = await import('@/lib/data/source-finance'))

    const buyer = await query<{ id: string }>(
      `INSERT INTO managers (name, email, password_hash, status, role)
       VALUES ('buyer-fin', $1, 'x', 'active', 'buyer') RETURNING id`,
      [`buyer-fin-${suffix}@test.invalid`],
    )
    buyerId = buyer[0].id
    const other = await query<{ id: string }>(
      `INSERT INTO managers (name, email, password_hash, status, role)
       VALUES ('buyer-fin2', $1, 'x', 'active', 'buyer') RETURNING id`,
      [`buyer-fin2-${suffix}@test.invalid`],
    )
    otherBuyerId = other[0].id

    const src = await query<{ id: string }>(
      `INSERT INTO traffic_sources (id, name, platform_key, currency, setup_completed)
       VALUES (gen_random_uuid(), $1, 'yandex_direct', 'RUB', true) RETURNING id`,
      [`src-fin-${suffix}`],
    )
    sourceId = src[0].id
    // Привязываем байера-владельца к источнику.
    await query(`UPDATE managers SET traffic_source_id = $1 WHERE id = $2`, [
      sourceId,
      buyerId,
    ])
  })

  afterAll(async () => {
    if (sourceId) {
      await query(`DELETE FROM source_spend_daily WHERE source_id = $1`, [sourceId])
      await query(`DELETE FROM source_deposits WHERE source_id = $1`, [sourceId])
      await query(`UPDATE managers SET traffic_source_id = NULL WHERE traffic_source_id = $1`, [sourceId])
      await query(`DELETE FROM traffic_sources WHERE id = $1`, [sourceId])
    }
    if (buyerId) await query(`DELETE FROM managers WHERE id = $1`, [buyerId])
    if (otherBuyerId) await query(`DELETE FROM managers WHERE id = $1`, [otherBuyerId])
    await closePool()
  })

  it('pending-депозит не входит в баланс, но виден отдельно', async () => {
    const dep = await createDeposit({
      sourceId,
      buyerId,
      createdBy: null,
      createdByKind: 'admin',
      origAmount: 100000,
      origCurrency: 'RUB',
      fxRate: 1,
      purpose: 'Тест бюджета',
    })
    expect(dep.status).toBe('pending')
    expect(dep.amount).toBe(100000)

    const s = await getSourceFinanceSummary(sourceId)
    expect(s.pendingDeposits).toBe(100000)
    expect(s.confirmedDeposits).toBe(0)
    expect(s.balance).toBe(0)
    expect(s.pendingCount).toBe(1)
  })

  it('подтверждение депозита включает его в баланс', async () => {
    const dep = await createDeposit({
      sourceId,
      buyerId,
      createdBy: null,
      createdByKind: 'admin',
      origAmount: 50000,
      origCurrency: 'RUB',
      fxRate: 1,
    })
    const confirmed = await decideDeposit({
      depositId: dep.id,
      buyerId,
      decision: 'confirmed',
    })
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.decidedAt).not.toBeNull()

    const s = await getSourceFinanceSummary(sourceId)
    // 50000 подтверждено, 100000 всё ещё pending.
    expect(s.confirmedDeposits).toBe(50000)
    expect(s.balance).toBe(50000)
  })

  it('чужой байер не может решить по депозиту', async () => {
    const dep = await createDeposit({
      sourceId,
      buyerId,
      createdBy: null,
      createdByKind: 'admin',
      origAmount: 1000,
      origCurrency: 'RUB',
      fxRate: 1,
    })
    await expect(
      decideDeposit({ depositId: dep.id, buyerId: otherBuyerId, decision: 'confirmed' }),
    ).rejects.toThrow()
    // Чистим этот лишний депозит, чтобы не влиять на баланс дальше.
    await query(`DELETE FROM source_deposits WHERE id = $1`, [dep.id])
  })

  it('нельзя решить дважды (только из pending)', async () => {
    const dep = await createDeposit({
      sourceId,
      buyerId,
      createdBy: null,
      createdByKind: 'admin',
      origAmount: 2000,
      origCurrency: 'RUB',
      fxRate: 1,
    })
    await decideDeposit({ depositId: dep.id, buyerId, decision: 'confirmed' })
    await expect(
      decideDeposit({ depositId: dep.id, buyerId, decision: 'rejected', note: 'поздно' }),
    ).rejects.toThrow()
    await query(`DELETE FROM source_deposits WHERE id = $1`, [dep.id])
  })

  it('FX-заморозка: amount = orig_amount × fx_rate в базовой валюте', async () => {
    const dep = await createDeposit({
      sourceId,
      buyerId,
      createdBy: null,
      createdByKind: 'admin',
      origAmount: 100,
      origCurrency: 'USD',
      fxRate: 92.5,
    })
    expect(dep.origCurrency).toBe('USD')
    expect(dep.amount).toBe(9250) // 100 × 92.5
    await query(`DELETE FROM source_deposits WHERE id = $1`, [dep.id])
  })

  it('дневной лог трат — upsert по (source_id, date), не дублирует', async () => {
    const day = '2099-01-15'
    await upsertSpendDay({ sourceId, buyerId, spendDate: day, spend: 5000, leads: 10 })
    await upsertSpendDay({ sourceId, buyerId, spendDate: day, spend: 7000, leads: 14 })

    const rows = await query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM source_spend_daily WHERE source_id = $1 AND spend_date = $2`,
      [sourceId, day],
    )
    expect(Number(rows[0].c)).toBe(1) // upsert, не два ряда

    const [row] = await query<{ spend: string; leads: string }>(
      `SELECT spend, leads FROM source_spend_daily WHERE source_id = $1 AND spend_date = $2`,
      [sourceId, day],
    )
    expect(Number(row.spend)).toBe(7000) // перезаписано
    expect(Number(row.leads)).toBe(14)
  })

  it('баланс = confirmed − spend, метрики считаются', async () => {
    // На этой точке: confirmed = 50000 (из теста 2), spend = 7000 (из upsert).
    const s = await getSourceFinanceSummary(sourceId)
    expect(s.confirmedDeposits).toBe(50000)
    expect(s.totalSpend).toBe(7000)
    expect(s.balance).toBe(43000)
    expect(s.leads).toBe(14)
    // utilization = spend / confirmed × 100 = 14%
    expect(Math.round(s.utilization)).toBe(14)
  })
})
