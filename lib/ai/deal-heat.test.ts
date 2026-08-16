/**
 * Unit tests for deal-heat scoring: the deterministic 0..100 "how hot is this
 * client" heuristic. The db layer is mocked with synthetic aggregate rows so
 * we can pin the scoring math, bands, clamping and ordering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()
vi.mock('../db', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
}))

import { getDealHeat, listDealHeat } from './deal-heat'

/** A heat aggregate row as the SQL would return it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    contact_name: 'Клиент',
    channel_type: 'telegram',
    status: 'new',
    client_msgs: '0',
    manager_msgs: '0',
    client_questions: '0',
    hours_since_last: null,
    hours_since_client: null,
    last_dir: null,
    ...overrides,
  }
}

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue([])
})

describe('getDealHeat scoring', () => {
  it('returns null when the conversation is not found or not enrolled', async () => {
    expect(await getDealHeat('missing')).toBeNull()
  })

  it('scores a hot deal: liquid + active chat + fresh + awaiting us', async () => {
    queryMock.mockResolvedValue([
      row({
        status: 'liquid', // +45
        client_msgs: '9', // +20
        client_questions: '3', // +12
        last_dir: 'in', // +12 (awaiting us)
        hours_since_client: '2', // +15 (wrote just now)
        hours_since_last: '2',
      }),
    ])
    const heat = await getDealHeat('conv-1')
    expect(heat).not.toBeNull()
    expect(heat!.score).toBe(100) // 104 clamped to 100
    expect(heat!.band).toBe('hot')
    expect(heat!.awaitingUs).toBe(true)
    expect(heat!.reasons).toContain('ждёт нашего ответа')
  })

  it('scores a cold deal: not_liquid and silent for over a week', async () => {
    queryMock.mockResolvedValue([
      row({
        status: 'not_liquid', // -15
        client_msgs: '1', // +5
        hours_since_client: '200', // -18 (silent > week)
        hours_since_last: '200',
        last_dir: 'out',
      }),
    ])
    const heat = await getDealHeat('conv-1')
    expect(heat!.score).toBe(0) // negative sum clamped to 0
    expect(heat!.band).toBe('cold')
    expect(heat!.awaitingUs).toBe(false)
  })

  it('handoff prior beats primary contact', async () => {
    queryMock.mockResolvedValue([row({ status: 'handoff' })])
    const handoff = await getDealHeat('conv-1')
    queryMock.mockResolvedValue([row({ status: 'new' })])
    const fresh = await getDealHeat('conv-1')
    expect(handoff!.score).toBeGreaterThan(fresh!.score)
  })

  it('band thresholds: 70=hot, 45=warm, 20=cool, below=cold', async () => {
    // liquid(45) + 3 msgs(12) + 1 question(6) + today(8) = 71 → hot
    queryMock.mockResolvedValue([
      row({
        status: 'liquid',
        client_msgs: '3',
        client_questions: '1',
        hours_since_client: '20',
        hours_since_last: '20',
        last_dir: 'out',
      }),
    ])
    expect((await getDealHeat('x'))!.band).toBe('hot')

    // transferred(15) + 1 msg(5) = 20 → cool (lower bound)
    queryMock.mockResolvedValue([
      row({ status: 'transferred', client_msgs: '1' }),
    ])
    expect((await getDealHeat('x'))!.band).toBe('cool')
  })
})

describe('listDealHeat', () => {
  it('sorts hottest-first and respects the limit cap', async () => {
    queryMock.mockResolvedValue([
      row({ id: 'cold', status: 'not_liquid', hours_since_client: '300' }),
      row({
        id: 'hot',
        status: 'liquid',
        client_msgs: '9',
        hours_since_client: '1',
        last_dir: 'in',
      }),
      row({ id: 'warm', status: 'handoff', client_msgs: '3' }),
    ])
    const list = await listDealHeat(2)
    expect(list.map((d) => d.conversationId)).toEqual(['hot', 'warm'])
  })
})
