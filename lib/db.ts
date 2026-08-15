import { Pool, type PoolClient, type QueryResultRow } from 'pg'

/**
 * Single source of truth for the PostgreSQL connection.
 *
 * The whole app talks to Postgres through the standard `pg` driver using the
 * `DATABASE_URL` environment variable, so it stays 100% portable to any VPS:
 * point DATABASE_URL at your own Postgres and run the migrations in scripts/.
 *
 * There is no in-memory fallback: the panel requires a real database. If
 * DATABASE_URL is missing the app fails fast with a clear, actionable error.
 */

// Reuse the pool across hot reloads in development / across route handlers.
const globalForDb = globalThis as unknown as { __pgPool?: Pool }

/**
 * Resolve TLS settings for the connection.
 *
 * Security: when TLS is used we VALIDATE the server certificate by default
 * (`rejectUnauthorized: true`) so the connection — which carries every message
 * and every decrypted secret — cannot be MITM'd. Provide a custom CA via
 * `DATABASE_CA_CERT` (PEM contents) for managed providers / self-signed certs.
 *
 * Verification can be disabled explicitly with `DATABASE_SSL_NO_VERIFY=true`
 * (e.g. a trusted private network where you accept the risk), but it is never
 * the default.
 */
export function resolveSslConfig(
  connectionString: string,
): false | { rejectUnauthorized: boolean; ca?: string } {
  const wantsSsl =
    connectionString.includes('sslmode=require') ||
    connectionString.includes('sslmode=verify') ||
    process.env.DATABASE_SSL === 'true'

  if (!wantsSsl) return false

  if (process.env.DATABASE_SSL_NO_VERIFY === 'true') {
    console.warn(
      '[db] DATABASE_SSL_NO_VERIFY=true — the database TLS certificate is NOT ' +
        'verified. This exposes the connection to MITM attacks; prefer setting ' +
        'DATABASE_CA_CERT instead.',
    )
    return { rejectUnauthorized: false }
  }

  const ca = process.env.DATABASE_CA_CERT
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) }
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Configure it in your environment ' +
        '(see .env.example) and run `pnpm db:migrate`.',
    )
  }
  // Pool size must accommodate concurrent managers, the realtime listener,
  // webhook handlers and the worker. 10 is far too small once several
  // managers are online (getSession hits the DB on every request), so default
  // to 20 and allow tuning per deployment via PGPOOL_MAX. connectionTimeoutMillis
  // makes callers fail fast with a clear error instead of hanging forever when
  // the pool is exhausted.
  const maxRaw = Number.parseInt(process.env.PGPOOL_MAX || '', 10)
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 20
  const pool = new Pool({
    connectionString,
    ssl: resolveSslConfig(connectionString),
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  pool.on('error', (err) => {
    console.error('[db] Unexpected PostgreSQL pool error:', err.message)
  })
  return pool
}

export function getPool(): Pool {
  if (!globalForDb.__pgPool) {
    globalForDb.__pgPool = createPool()
  }
  return globalForDb.__pgPool
}

/**
 * Drain and dispose the shared pool. Production code never calls this (the
 * pool lives for the process); it exists so integration tests can release
 * their connections and let the test runner exit cleanly.
 */
export async function closePool(): Promise<void> {
  const pool = globalForDb.__pgPool
  if (!pool) return
  globalForDb.__pgPool = undefined
  await pool.end()
}

/**
 * Live pool utilisation snapshot for health checks / metrics logging.
 * - total: open connections, - idle: free connections,
 * - waiting: callers queued for a connection (a persistently high value means
 *   the pool is the bottleneck — raise PGPOOL_MAX). max is the configured cap.
 */
export function getPoolStats(): {
  total: number
  idle: number
  waiting: number
  max: number
} {
  const pool = getPool()
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: (pool.options as { max?: number }).max ?? 0,
  }
}

export interface DbExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>
}

/**
 * Slow-query threshold in milliseconds. Any statement that takes longer is
 * logged (once, with its duration and a normalized snippet) so real hot spots
 * surface in the pm2 logs instead of being guessed at. Tunable per deployment
 * via DB_SLOW_QUERY_MS; set to 0 to disable. Default 500ms.
 */
const SLOW_QUERY_MS = (() => {
  const raw = Number.parseInt(process.env.DB_SLOW_QUERY_MS || '', 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : 500
})()

/** Collapse whitespace and truncate so a slow-query log line stays one row. */
function summarizeSql(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat
}

/** Log a warning when a query exceeded the slow threshold. Never throws. */
function maybeLogSlow(text: string, startedAt: number, rowCount: number): void {
  if (SLOW_QUERY_MS <= 0) return
  const ms = Math.round(performance.now() - startedAt)
  if (ms < SLOW_QUERY_MS) return
  console.warn(
    `[db] slow query ${ms}ms (rows=${rowCount}): ${summarizeSql(text)}`,
  )
}

function executorFor(client: PoolClient): DbExecutor {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ): Promise<T[]> {
      const startedAt = performance.now()
      const result = await client.query<T>(text, params as never)
      maybeLogSlow(text, startedAt, result.rowCount ?? result.rows.length)
      return result.rows
    },
  }
}

export async function withTransaction<T>(
  operation: (db: DbExecutor) => Promise<T>,
  pool: Pick<Pool, 'connect'> = getPool(),
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(executorFor(client))
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      console.error('[db] Transaction rollback failed:', rollbackError)
    }
    throw error
  } finally {
    client.release()
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const startedAt = performance.now()
  try {
    const result = await getPool().query<T>(text, params as never)
    maybeLogSlow(text, startedAt, result.rowCount ?? result.rows.length)
    return result.rows
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[db] Query failed:', message)
    // Preserve the Postgres error code (and the original error as `cause`)
    // on the wrapped error: callers rely on `.code` for control flow —
    // e.g. 23505 unique-violation retries (lib/god-sites.ts) and 42P01
    // missing-table detection (app/actions/managers.ts). A bare
    // `new Error(...)` silently broke those checks.
    const wrapped = new Error(`Database error: ${message}`, { cause: err })
    const code = (err as { code?: unknown })?.code
    if (typeof code === 'string') {
      ;(wrapped as Error & { code?: string }).code = code
    }
    throw wrapped
  }
}

export async function checkDbConnection(): Promise<{
  ok: boolean
  message: string
}> {
  if (!process.env.DATABASE_URL) {
    return {
      ok: false,
      message: 'DATABASE_URL is not configured.',
    }
  }
  try {
    await query('SELECT 1')
    return { ok: true, message: 'Connected to PostgreSQL.' }
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error ? err.message : 'Failed to connect to PostgreSQL.',
    }
  }
}
