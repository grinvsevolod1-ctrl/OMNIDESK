/**
 * Юнит-тесты маршрутизации пула (resolveTeamPoolTargets) и сводки команды
 * (listTeamStats). db и region-aware поиск findCuratorsByCity замоканы —
 * проверяем именно логику выбора кураторов и маппинг агрегатов, без БД.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()
const findByCityMock =
  vi.fn<(city: string) => Promise<{ id: string }[]>>()

vi.mock('../db', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
  withTransaction: vi.fn(),
}))
vi.mock('./lead-curators', () => ({
  findCuratorsByCity: (city: string) => findByCityMock(city),
}))

import { listTeamStats, resolveTeamPoolTargets } from './teams'

beforeEach(() => {
  queryMock.mockReset()
  findByCityMock.mockReset()
  queryMock.mockResolvedValue([])
})

describe('resolveTeamPoolTargets', () => {
  it('returns empty (not matched) when the team has no curators', async () => {
    // listTeamCuratorIds → пусто.
    queryMock.mockResolvedValueOnce([])
    const res = await resolveTeamPoolTargets('team-1', 'Москва')
    expect(res).toEqual({ curatorIds: [], matchedByCity: false })
    // Раз кураторов нет — по городу даже не ищем.
    expect(findByCityMock).not.toHaveBeenCalled()
  })

  it('narrows to curators of THIS team when city matches', async () => {
    // Команда: c1, c2. По городу совпали c2 (свой) и cX (чужой) — берём только c2.
    queryMock.mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }])
    findByCityMock.mockResolvedValueOnce([{ id: 'c2' }, { id: 'cX' }])
    const res = await resolveTeamPoolTargets('team-1', 'Москва')
    expect(res).toEqual({ curatorIds: ['c2'], matchedByCity: true })
  })

  it('falls back to the whole team when no city curator matches', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }])
    findByCityMock.mockResolvedValueOnce([{ id: 'cX' }]) // чужой — не в команде
    const res = await resolveTeamPoolTargets('team-1', 'Тверь')
    expect(res).toEqual({ curatorIds: ['c1', 'c2'], matchedByCity: false })
  })

  it('falls back to the whole team when city is blank', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'c1' }])
    const res = await resolveTeamPoolTargets('team-1', '   ')
    expect(res).toEqual({ curatorIds: ['c1'], matchedByCity: false })
    expect(findByCityMock).not.toHaveBeenCalled()
  })

  it('falls back to the whole team when city search throws', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'c1' }])
    findByCityMock.mockRejectedValueOnce(new Error('boom'))
    const res = await resolveTeamPoolTargets('team-1', 'Москва')
    expect(res).toEqual({ curatorIds: ['c1'], matchedByCity: false })
  })
})

describe('listTeamStats', () => {
  it('returns an empty map for no team ids without querying', async () => {
    const res = await listTeamStats([])
    expect(res.size).toBe(0)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('maps aggregate rows into a per-team stats map', async () => {
    queryMock.mockResolvedValueOnce([
      { team_id: 't1', pool: 2, claimed: 3, refused: 1, left: 0, total: 6 },
    ])
    const res = await listTeamStats(['t1', 't2'])
    expect(res.get('t1')).toEqual({
      pool: 2,
      claimed: 3,
      refused: 1,
      left: 0,
      total: 6,
    })
    // Команда без лидов в результате не появляется — вызывающий подставит нули.
    expect(res.has('t2')).toBe(false)
  })
})
