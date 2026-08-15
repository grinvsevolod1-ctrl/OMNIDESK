/**
 * Unit tests for the city dictionary: normalization, form parsing and the
 * curator city-set replacement (dedup, canonical spelling, batch SQL shape).
 * The db layer is mocked — we assert on the queries and their parameters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()
vi.mock('../db', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
  // setCuratorCities now runs inside a transaction; the mock routes the
  // transactional executor's queries through the same queryMock so the
  // assertions on SQL shape and parameters stay unchanged.
  withTransaction: async (
    operation: (db: {
      query: (sql: string, params?: unknown[]) => Promise<unknown[]>
    }) => Promise<unknown>,
  ) =>
    operation({
      query: (sql: string, params?: unknown[]) => queryMock(sql, params),
    }),
}))

import {
  cityKey,
  normalizeCityName,
  parseCityList,
  setCuratorCities,
} from './cities'

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue([])
})

describe('normalizeCityName / cityKey', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeCityName('  Нижний   Новгород ')).toBe('Нижний Новгород')
  })

  it('cityKey lower-cases the normalized name', () => {
    expect(cityKey(' МОСКВА  ')).toBe('москва')
    expect(cityKey('Санкт-Петербург')).toBe('санкт-петербург')
  })
})

describe('parseCityList', () => {
  it('splits on commas and semicolons, drops empties', () => {
    expect(parseCityList('Москва, Казань;  ; Уфа')).toEqual([
      'Москва',
      'Казань',
      'Уфа',
    ])
  })

  it('returns empty array for blank input', () => {
    expect(parseCityList('   ')).toEqual([])
  })
})

describe('setCuratorCities', () => {
  it('rejects an empty city set', async () => {
    await expect(setCuratorCities('c1', ['', '  '])).rejects.toThrow(
      'хотя бы один город',
    )
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('dedupes case-insensitively and keeps first spelling order', async () => {
    // Dictionary returns canonical spellings keyed by name_norm.
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO cities')) {
        return [
          { name: 'Москва', name_norm: 'москва' },
          { name: 'Казань', name_norm: 'казань' },
        ]
      }
      return []
    })

    const result = await setCuratorCities('c1', [
      ' Москва ',
      'москва',
      'КАЗАНЬ',
    ])
    expect(result).toEqual(['Москва', 'Казань'])

    // Batch dictionary insert got the deduped names + keys as arrays.
    const dictCall = queryMock.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO cities'),
    )
    expect(dictCall?.[1]).toEqual([
      ['Москва', 'КАЗАНЬ'],
      ['москва', 'казань'],
    ])

    // The link table is replaced with canonical spellings in one batch.
    const linkCall = queryMock.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO curator_cities'),
    )
    expect(linkCall?.[1]).toEqual(['c1', ['Москва', 'Казань']])

    // managers.city gets the primary (first) canonical city.
    const managerCall = queryMock.mock.calls.find(([sql]) =>
      sql.includes('UPDATE managers'),
    )
    expect(managerCall?.[1]).toEqual(['c1', 'Москва'])
  })

  it('canonical spelling from the dictionary wins over the typed variant', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO cities')) {
        // Dictionary already knows this city as «Санкт-Петербург».
        return [{ name: 'Санкт-Петербург', name_norm: 'санкт-петербург' }]
      }
      return []
    })
    const result = await setCuratorCities('c2', ['САНКТ-ПЕТЕРБУРГ'])
    expect(result).toEqual(['Санкт-Петербург'])
  })
})
