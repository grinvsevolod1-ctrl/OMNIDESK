/**
 * Unit tests for curator discipline aggregation: the GROUP BY row → snapshot
 * mapping (one row per curator+status), history percentages and the overdue
 * list. The db layer is mocked with synthetic aggregate rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()
vi.mock('../db', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
}))

import {
  getCuratorDiscipline,
  getCuratorDisciplineHistory,
  listCuratorsWithOverdueStatuses,
} from './lead-discipline'

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue([])
})

describe('getCuratorDiscipline', () => {
  it('collapses per-status rows into one snapshot per curator', async () => {
    // GROUP BY returns one row per curator+status; the window sums repeat
    // the same totals on every row of a curator.
    queryMock.mockResolvedValue([
      {
        curator_id: 'c1',
        curator_name: 'Борис',
        city: 'Москва',
        total_leads: '5',
        confirmed_today: '3',
        pending_today: '2',
        status: 'working',
        status_count: '4',
      },
      {
        curator_id: 'c1',
        curator_name: 'Борис',
        city: 'Москва',
        total_leads: '5',
        confirmed_today: '3',
        pending_today: '2',
        status: 'refused',
        status_count: '1',
      },
      {
        curator_id: 'c2',
        curator_name: 'Анна',
        city: null,
        total_leads: '0',
        confirmed_today: '0',
        pending_today: '0',
        status: null, // curator without leads: LEFT JOIN produces a null row
        status_count: '0',
      },
    ])

    const result = await getCuratorDiscipline()
    expect(result).toHaveLength(2)
    // Sorted by name (ru locale): Анна before Борис.
    expect(result.map((r) => r.curatorName)).toEqual(['Анна', 'Борис'])

    const boris = result.find((r) => r.curatorId === 'c1')!
    expect(boris.totalLeads).toBe(5)
    expect(boris.confirmedToday).toBe(3)
    expect(boris.pendingToday).toBe(2)
    expect(boris.statusCounts).toEqual({ working: 4, refused: 1 })

    const anna = result.find((r) => r.curatorId === 'c2')!
    expect(anna.totalLeads).toBe(0)
    expect(anna.statusCounts).toEqual({}) // null status is not a lead status
  })
})

describe('getCuratorDisciplineHistory', () => {
  it('computes the on-time percentage and rounds it', async () => {
    queryMock.mockResolvedValue([
      { curator_id: 'c1', active_days: '20', total_confirms: '3', on_time: '2' },
      { curator_id: 'c2', active_days: '1', total_confirms: '0', on_time: '0' },
    ])
    const map = await getCuratorDisciplineHistory(30)
    expect(map.get('c1')).toEqual({
      curatorId: 'c1',
      activeDays: 20,
      totalConfirms: 3,
      onTimeConfirms: 2,
      onTimeRatePct: 67, // 2/3 rounded
    })
    // Zero confirms must not divide by zero.
    expect(map.get('c2')!.onTimeRatePct).toBe(0)
  })

  it('passes the day window to the query', async () => {
    await getCuratorDisciplineHistory(7)
    expect(queryMock.mock.calls[0]?.[1]).toEqual([7])
  })
})

describe('listCuratorsWithOverdueStatuses', () => {
  it('maps rows and coerces pending to a number', async () => {
    queryMock.mockResolvedValue([
      { curator_id: 'c1', curator_name: 'Борис', pending: '4' },
    ])
    const list = await listCuratorsWithOverdueStatuses()
    expect(list).toEqual([
      { curatorId: 'c1', curatorName: 'Борис', pending: 4 },
    ])
  })
})
