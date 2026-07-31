import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { withTransaction } from './db'

function setupClient() {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  const release = vi.fn()
  const client = { query, release } as unknown as PoolClient
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pick<Pool, 'connect'>
  return { query, release, pool }
}

describe('withTransaction', () => {
  it('commits and releases a successful operation', async () => {
    const { query, release, pool } = setupClient()
    query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: '1' }] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await withTransaction(
      (db) => db.query<{ id: string }>('SELECT id FROM example'),
      pool,
    )

    expect(result).toEqual([{ id: '1' }])
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT id FROM example',
      'COMMIT',
    ])
    expect(release).toHaveBeenCalledOnce()
  })

  it('rolls back, releases, and preserves the original error', async () => {
    const { query, release, pool } = setupClient()
    const failure = new Error('write failed')

    await expect(
      withTransaction(async () => {
        throw failure
      }, pool),
    ).rejects.toBe(failure)

    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK'])
    expect(release).toHaveBeenCalledOnce()
  })
})
